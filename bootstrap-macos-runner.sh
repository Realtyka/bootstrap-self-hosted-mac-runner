#!/usr/bin/env bash
set -euo pipefail

# ==================================================
# REQUIRED VERSIONS (FAIL IF NOT EXACT)
# ==================================================
REQUIRED_XCODE_VERSION="26.6"
REQUIRED_NODE_VERSION="24.16.0"
REQUIRED_RUBY_VERSION="3.1.2"
REQUIRED_COCOAPODS_VERSION="1.16.2"
NVM_VERSION="v0.40.4"

# Xcode 26.4 raised the floor from macOS 15.6 to macOS 26.2. An older runner can
# install Xcode 26.6 but the app will refuse to launch, so fail before the
# multi-gigabyte download rather than halfway through provisioning.
REQUIRED_MACOS_VERSION="26.2"

# Simulator pinning.
#
# The runtime is pinned by MAJOR version only, and the newest installed iOS 26.x
# is resolved at run time. Apple does not keep simulator runtime versions in step
# with Xcode minor versions — Xcode 26.6 ships the iOS 26.5 SDK and no "iOS 26.6"
# runtime exists — so an exact runtime pin would need re-editing on every Xcode
# bump and would hard-fail whenever the two drift.
REQUIRED_IOS_SIM_RUNTIME_MAJOR="26"
REQUIRED_SIM_DEVICE_TYPE="iPhone 17 Pro"
# Optional escape hatch if runtime install isn't supported automatically:
# Provide a local path to a downloaded runtime DMG
# Example: export IOS_RUNTIME_DMG_PATH="/path/to/iOS_26.5_Simulator_Runtime.dmg"
IOS_RUNTIME_DMG_PATH="${IOS_RUNTIME_DMG_PATH:-}"

# Superseded toolchains removed by this script. Exact versions only, so anything
# installed on a runner outside this script is left alone.
LEGACY_XCODE_VERSIONS=("16.4" "26.0")
LEGACY_NODE_VERSIONS=("22.12.0")

# ==================================================
# Helpers
# ==================================================
log() { echo -e "\n\033[1;34m==>\033[0m $*"; }
die() { echo -e "\n\033[1;31mERROR:\033[0m $*" >&2; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

# True when $1 >= $2, comparing dotted version strings.
version_gte() {
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

# ==================================================
# Command Line Tools helpers
# ==================================================
# Every developer shim in /usr/bin (git, clang, xcodebuild, xcrun) resolves
# through the active developer directory. With none set they all fail with
# "No developer tools were found, requesting install." — which is how a runner
# ends up with a Homebrew that can never run `brew update`.
developer_dir_is_usable() {
  local dir
  dir="$(/usr/bin/xcode-select -p 2>/dev/null)" || return 1
  [[ -n "${dir}" && -d "${dir}" ]] || return 1
  /usr/bin/git --version >/dev/null 2>&1
}

# Headless CLT install. `xcode-select --install` is deliberately NOT used: it
# opens a GUI dialog nobody can click on an unattended runner. softwareupdate
# only offers the CLT package while the sentinel file exists — that pairing is
# the long-standing non-interactive route.
install_command_line_tools() {
  local sentinel="/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress"
  local label rc=0
  sudo touch "${sentinel}"
  # Newest label wins: several "Command Line Tools for Xcode-<ver>" rows can be
  # offered at once, and sort -V orders them by version rather than by the order
  # softwareupdate happens to print them in.
  label="$(softwareupdate -l 2>/dev/null \
           | awk -F'Label: ' '/Label: Command Line Tools/ {print $2}' \
           | sort -V | tail -n1)"
  if [[ -n "${label}" ]]; then
    log "Installing ${label} (this takes a few minutes)..."
    sudo softwareupdate -i "${label}" --verbose || rc=1
  else
    rc=1
  fi
  sudo rm -f "${sentinel}"
  return "${rc}"
}

# ==================================================
# Xcode uninstall helpers
# ==================================================
# `xcodes installed <version>` is the only non-interactive presence probe: it
# prints the app bundle path and exits 0, or exits 1 when the version is absent.
#
# Deliberately NOT used here:
#   * `xcodes installed | grep "^<ver>\b"` — the `.` is a regex wildcard and the
#     `\b` sits on the 0/. boundary, so `^26.0\b` also matches a `26.0.1` row.
#   * a constructed path — xcodes always writes three version components, so
#     `xcodes install 26.6` yields /Applications/Xcode-26.6.0.app and a
#     hand-rolled `Xcode-26.6.app` guess would never match.
#
# xcodes logs everything through print() — including errors — to stdout, and an
# unparseable version makes `installed` dump the entire table and still exit 0.
# So require a zero exit AND a single-line path to an existing bundle.
xcode_path_for_version() {
  local version="$1" out
  command_exists xcodes || return 1
  out="$(xcodes installed "${version}" --no-color 2>/dev/null)" || return 1
  [[ "${out}" == *$'\n'* ]] && return 1          # multi-line => the whole table
  [[ "${out}" == /*.app && -d "${out}" ]] || return 1
  printf '%s\n' "${out}"
}

# True when the given app bundle is what xcode-select currently points at.
xcode_is_selected() {
  local selected
  selected="$(xcode-select -p 2>/dev/null || true)"
  [[ -n "${selected}" && "${selected}" == "${1}/"* ]]
}

_uninstall_xcode_bundle() {
  local version="$1" app="$2"
  # A running Xcode or Simulator from this bundle blocks the delete. Anchored to
  # the bundle path so the pattern cannot match this script itself.
  pkill -f "^${app}/Contents/MacOS/" 2>/dev/null || true

  log "Uninstalling Xcode ${version} (${app})..."
  # --empty-trash : without it the ~30 GB bundle only moves to ~/.Trash and the
  #                 runner's disk is never actually reclaimed. Nothing empties
  #                 the Trash on a headless auto-login box.
  # </dev/null    : if the version disappears between the probe and this call,
  #                 xcodes falls back to an INTERACTIVE picker (it calls
  #                 readLine on stdin). On a TTY that hangs provisioning
  #                 forever; at EOF it exits non-zero instead.
  # no sudo       : xcodes deletes as the invoking user (/Applications is
  #                 drwxrwxr-x root:admin); sudo would relocate its config,
  #                 keychain and Trash to /var/root.
  if ! xcodes uninstall "${version}" --empty-trash --no-color </dev/null; then
    die "xcodes uninstall ${version} failed (bundle still at ${app})"
  fi
  if [[ -d "${app}" ]]; then
    die "Xcode ${version} still present at ${app} after uninstall"
  fi
  log "Xcode ${version} removed"
}

# Strict: idempotent no-op when absent, hard failure when the target is the
# currently selected Xcode. Use only AFTER the replacement has been selected.
uninstall_xcode_if_present() {
  local version="$1" app
  if ! app="$(xcode_path_for_version "${version}")"; then
    log "Xcode ${version} is not installed — nothing to uninstall"
    return 0
  fi
  if xcode_is_selected "${app}"; then
    die "Refusing to uninstall Xcode ${version}: it is the currently selected Xcode.
     Select Xcode ${REQUIRED_XCODE_VERSION} first (sudo xcode-select -s <app>/Contents/Developer)."
  fi
  _uninstall_xcode_bundle "${version}" "${app}"
}

# Opportunistic: used BEFORE the replacement is selected, to cap peak disk use.
# Skips (never aborts) when the target is the selected Xcode — removing it there
# would leave /var/db/xcode_select_link dangling, and xcode-select does not fall
# back, so every later xcodebuild/xcrun call would fail. The strict pass removes
# it once Xcode ${REQUIRED_XCODE_VERSION} is active.
try_uninstall_xcode() {
  local version="$1" app
  app="$(xcode_path_for_version "${version}")" || return 0
  if xcode_is_selected "${app}"; then
    log "Xcode ${version} is currently selected — deferring removal until ${REQUIRED_XCODE_VERSION} is active"
    return 0
  fi
  _uninstall_xcode_bundle "${version}" "${app}"
}

# ==================================================
# macOS version floor (FAIL FAST)
# ==================================================
# First real statement in the script on purpose: sw_vers and sort -V are both in
# the base system, so this can run before Homebrew, before any download, and
# before anything is removed.
MACOS_VERSION="$(sw_vers -productVersion)"
version_gte "${MACOS_VERSION}" "${REQUIRED_MACOS_VERSION}" \
  || die "Xcode ${REQUIRED_XCODE_VERSION} requires macOS ${REQUIRED_MACOS_VERSION} or later; this host runs ${MACOS_VERSION}. Upgrade macOS before provisioning this runner."
log "macOS OK: ${MACOS_VERSION}"

# ==================================================
# 0) Command Line Tools (git, clang) — BEFORE Homebrew
# ==================================================
# Ordering is load-bearing. Homebrew's own installer normally drags the CLT in,
# but the Homebrew step below skips that installer whenever brew already exists,
# so a runner that acquired Homebrew by any other route (tarball, restored disk
# image, another provisioning script) reaches `brew update` with no git at all.
#
# CLT rather than Xcode is the right early dependency: it supplies git and clang
# on a virgin box, installs unattended, and needs neither an Apple ID nor a 12 GB
# download. Xcode cannot go first — `xcodes` is installed into $(brew --prefix)/bin,
# so Homebrew necessarily precedes it.
log "Ensuring Command Line Tools (git, clang)..."
if ! developer_dir_is_usable; then
  # Common on a runner whose selected Xcode was deleted out from under
  # xcode-select: the CLT are on disk but nothing points at them.
  if [[ -x /Library/Developer/CommandLineTools/usr/bin/git ]]; then
    log "Command Line Tools present but not active — selecting them"
    sudo xcode-select -s /Library/Developer/CommandLineTools
  fi
  if ! developer_dir_is_usable; then
    install_command_line_tools \
      || die "Could not install the Command Line Tools automatically. Run 'xcode-select --install' on this host, finish the dialog, then re-run this script."
    if ! developer_dir_is_usable && [[ -x /Library/Developer/CommandLineTools/usr/bin/git ]]; then
      sudo xcode-select -s /Library/Developer/CommandLineTools
    fi
  fi
  developer_dir_is_usable \
    || die "Command Line Tools still unusable after install. git is required before Homebrew can run."
fi
# Only ever reached without touching an already-valid selection, so a runner that
# already has an Xcode selected keeps it — the Xcode step below owns that choice.
log "Developer tools OK: $(/usr/bin/xcode-select -p) ($(/usr/bin/git --version))"

# ==================================================
# 1) Homebrew (official installer)
# ==================================================
log "Ensuring Homebrew is installed..."

# Ensure brew is on PATH (Apple Silicon + Intel)
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

if ! command_exists brew; then
  log "Installing Homebrew..."
  # Fetched to a file rather than `bash -c "$(curl ...)"`: with -f -s a failed
  # fetch prints nothing and expands to the empty string, so `bash -c ""` exits 0
  # and the run sails on to `brew update` as though Homebrew had been installed.
  HOMEBREW_INSTALLER="$(mktemp -t homebrew-install)"
  curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh \
    -o "${HOMEBREW_INSTALLER}" \
    || die "Could not download the Homebrew installer from raw.githubusercontent.com."
  [[ -s "${HOMEBREW_INSTALLER}" ]] || die "Homebrew installer downloaded empty."
  /bin/bash "${HOMEBREW_INSTALLER}"
  rm -f "${HOMEBREW_INSTALLER}"
  # Set up PATH after fresh install
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  else
    die "Homebrew installed but brew not found on PATH"
  fi
fi

# Best effort, never fatal. `brew update` hard-fails on a Homebrew that has no
# git repository — `brew config` reports "shallow or no git repository" — and it
# exits 1 printing NOTHING at all, so under `set -e` it killed the entire run
# with a blank screen and no diagnostic. Homebrew 4.x resolves formulae from the
# JSON API and refreshes that index during `brew install`, so the only cost of a
# skipped update is slightly staler metadata.
BREW_UPDATE_RC=0
brew update || BREW_UPDATE_RC=$?
if (( BREW_UPDATE_RC != 0 )); then
  log "Warning: 'brew update' exited ${BREW_UPDATE_RC} — continuing with the JSON API package index"
  if [[ ! -d "$(brew --repository)/.git" ]]; then
    log "  Cause: $(brew --repository) has no git repository, so 'brew update' can never succeed on this host. Reinstall Homebrew with the official installer to restore it."
  fi
fi

# ==================================================
# Xcode install (skip xcodes if already present)
# ==================================================
log "Ensuring Xcode ${REQUIRED_XCODE_VERSION} is installed..."

XCODE_ALREADY_INSTALLED=false
if command_exists xcodebuild; then
  CURRENT_XCODE_VERSION="$(xcodebuild -version 2>/dev/null | head -n1 | awk '{print $2}' || true)"
  if [[ "${CURRENT_XCODE_VERSION}" == "${REQUIRED_XCODE_VERSION}" ]]; then
    log "Xcode ${REQUIRED_XCODE_VERSION} is already installed and selected — skipping install"
    XCODE_ALREADY_INSTALLED=true
  fi
fi

# Ensure the xcodes binary. Hoisted out of the install branch on purpose: even on
# a re-run where 26.6 is already selected we still need xcodes for the legacy
# cleanup below, and uninstalling requires no Apple ID.
# (Use the pre-built binary — the brew formula requires Xcode to compile from
# source, which defeats the purpose.)
if ! command_exists xcodes; then
  log "Installing xcodes (pre-built binary)..."
  curl -sL "https://github.com/XcodesOrg/xcodes/releases/latest/download/xcodes.zip" -o /tmp/xcodes.zip
  unzip -o /tmp/xcodes.zip -d /tmp
  install -m 755 /tmp/xcodes "$(brew --prefix)/bin/xcodes"
  rm -f /tmp/xcodes.zip /tmp/xcodes
fi

# Validate the download precondition BEFORE anything destructive runs. The
# pre-pass below permanently deletes Xcode bundles (xcodes --empty-trash calls
# removeItem, so there is no Trash copy to restore), and a missing Apple ID would
# otherwise abort the run *after* the old toolchain is gone but before the new one
# is installed — leaving the runner unable to build anything.
# xcodes README: you can provide Apple ID creds via XCODES_USERNAME / XCODES_PASSWORD
XCODE_NEEDS_DOWNLOAD=false
if [[ "${XCODE_ALREADY_INSTALLED}" == false ]] \
   && ! xcode_path_for_version "${REQUIRED_XCODE_VERSION}" >/dev/null; then
  if [[ -z "${XCODE_APPLE_ID:-}" || -z "${XCODE_APPLE_ID_PASSWORD:-}" ]]; then
    die "Xcode ${REQUIRED_XCODE_VERSION} is not installed and must be downloaded, which requires the XCODE_APPLE_ID and XCODE_APPLE_ID_PASSWORD env vars. Nothing has been removed — export them and re-run."
  fi
  export XCODES_USERNAME="${XCODE_APPLE_ID}"
  export XCODES_PASSWORD="${XCODE_APPLE_ID_PASSWORD}"
  XCODE_NEEDS_DOWNLOAD=true
fi

# Opportunistic legacy cleanup BEFORE the download, so a migrating runner never
# needs disk for three Xcodes plus a ~12 GB .xip at once.
log "Removing superseded Xcode versions (pre-pass)..."
for _legacy_xcode in "${LEGACY_XCODE_VERSIONS[@]}"; do
  try_uninstall_xcode "${_legacy_xcode}"
done

if [[ "${XCODE_ALREADY_INSTALLED}" == false ]]; then
  if [[ "${XCODE_NEEDS_DOWNLOAD}" == true ]]; then
    log "Downloading and installing Xcode ${REQUIRED_XCODE_VERSION} (this will take a while)..."
    xcodes install "${REQUIRED_XCODE_VERSION}" --select
  else
    log "Xcode ${REQUIRED_XCODE_VERSION} already installed — selecting it"
    xcodes select "${REQUIRED_XCODE_VERSION}"
  fi
fi

# Accept license (required for xcodebuild, CocoaPods, etc.)
sudo xcodebuild -license accept

# Install required system packages (CoreSimulator, simctl, etc.)
# This is critical: if a previous install was interrupted (e.g. SSH timeout),
# the Xcode app may exist but system components will be missing.
log "Installing Xcode first-launch system packages..."
sudo xcodebuild -runFirstLaunch

# Kill stale CoreSimulatorService — changing the active Xcode version causes a
# framework version mismatch (e.g. 1048 vs 1010.15) that makes simctl and runtime
# downloads fail. A migrating runner switches 16.4 -> 26.6 above, so this must
# run before the simctl functional check below.
log "Resetting CoreSimulatorService after Xcode version change..."
sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null || true
sleep 2

# ==================================================
# Validate Xcode version (FAIL FAST)
# ==================================================
ACTUAL_XCODE_VERSION="$(xcodebuild -version | head -n1 | awk '{print $2}')"
[[ "${ACTUAL_XCODE_VERSION}" == "${REQUIRED_XCODE_VERSION}" ]] \
  || die "Xcode version mismatch: expected ${REQUIRED_XCODE_VERSION}, got ${ACTUAL_XCODE_VERSION}"
log "Xcode OK: ${ACTUAL_XCODE_VERSION}"

# Validate Xcode components are functional (catches partial installs)
if ! xcrun simctl list devicetypes >/dev/null 2>&1; then
  die "Xcode ${REQUIRED_XCODE_VERSION} appears broken (simctl not functional). Remove it and re-run this script:\n  xcodes uninstall ${REQUIRED_XCODE_VERSION} --empty-trash && xcodes install ${REQUIRED_XCODE_VERSION} --select"
fi

# ==================================================
# Remove superseded Xcode versions (strict pass)
# ==================================================
# Safe only here: Xcode ${REQUIRED_XCODE_VERSION} is installed, selected and
# validated, so neither legacy version can still be the xcode-select target.
log "Removing superseded Xcode versions..."
for _legacy_xcode in "${LEGACY_XCODE_VERSIONS[@]}"; do
  uninstall_xcode_if_present "${_legacy_xcode}"
done

# Both passes gate on `xcodes installed`, which resolves a bundle by reading its
# Info.plist. A bundle left half-deleted by an interrupted run has no readable
# version, so it reports as "not installed" forever and its disk is never
# reclaimed. Check the canonical path xcodes would have used and say so out loud.
# Warn rather than die: a leftover directory wastes disk but does not make the
# provisioned toolchain wrong, and failing here would block the runner for it.
for _legacy_xcode in "${LEGACY_XCODE_VERSIONS[@]}"; do
  _legacy_app="/Applications/Xcode-${_legacy_xcode}.0.app"
  if [[ -d "${_legacy_app}" ]]; then
    log "Warning: ${_legacy_app} still exists but xcodes cannot resolve its version (likely a partially deleted bundle from an interrupted run). Remove it manually to reclaim the disk:\n  rm -rf '${_legacy_app}'"
  fi
done
unset _legacy_xcode _legacy_app

# Simulator runtimes are CoreSimulator disk images under
# /Library/Developer/CoreSimulator, and CoreSimulator.framework lives in
# /Library/Developer/PrivateFrameworks — none of it sits inside an Xcode bundle,
# so the uninstalls cannot have removed a runtime. Prove it rather than assume.
xcrun simctl list runtimes >/dev/null \
  || die "simctl is broken after removing the superseded Xcode versions"

# ==================================================
# Simulator runtime + device (iPhone 17 Pro / newest iOS 26.x)
# ==================================================
log "Ensuring an iOS ${REQUIRED_IOS_SIM_RUNTIME_MAJOR}.x simulator runtime and a '${REQUIRED_SIM_DEVICE_TYPE}' device exist..."

# Ensure the device type exists in this Xcode. Matched against the start of the
# trailing identifier so "iPhone 17 Pro" cannot be satisfied by a
# "iPhone 17 Pro Max" row.
if ! xcrun simctl list devicetypes | grep -Fq "${REQUIRED_SIM_DEVICE_TYPE} (com.apple."; then
  die "Simulator device type '${REQUIRED_SIM_DEVICE_TYPE}' not found in this Xcode. Check Xcode version/components."
fi

# Resolve the newest installed iOS <major>.x runtime.
# Prints "<version> <identifier>", or nothing when none is installed.
get_runtime_entry() {
  xcrun simctl list runtimes 2>/dev/null \
    | grep -E "^iOS ${REQUIRED_IOS_SIM_RUNTIME_MAJOR}\.[0-9]" \
    | grep -v -i 'unavailable' \
    | sed -E 's/^iOS ([0-9.]+) .* - (com\.apple\.CoreSimulator\.SimRuntime\.[A-Za-z0-9.-]+).*$/\1 \2/' \
    | sort -V \
    | tail -n1 || true
}

runtime_entry="$(get_runtime_entry)"

if [[ -z "${runtime_entry}" ]]; then
  log "No iOS ${REQUIRED_IOS_SIM_RUNTIME_MAJOR}.x runtime installed yet."

  # Primary: xcodebuild -downloadPlatform (Apple's native approach, Xcode 15+).
  # Fetches the latest iOS platform for the selected Xcode.
  log "Downloading iOS platform via xcodebuild..."
  set +e
  xcodebuild -downloadPlatform iOS
  set -e
  runtime_entry="$(get_runtime_entry)"

  # Fallback: xcodes runtimes install. It needs an explicit runtime name, so ask
  # xcodes for the newest iOS <major>.x it offers.
  if [[ -z "${runtime_entry}" ]] && command_exists xcodes; then
    log "xcodebuild did not yield an iOS ${REQUIRED_IOS_SIM_RUNTIME_MAJOR}.x runtime — falling back to xcodes..."
    runtime_candidate="$(xcodes runtimes 2>/dev/null \
      | grep -oE "^iOS ${REQUIRED_IOS_SIM_RUNTIME_MAJOR}\.[0-9.]+" \
      | sort -V \
      | tail -n1 || true)"
    if [[ -n "${runtime_candidate}" ]]; then
      set +e
      xcodes runtimes install "${runtime_candidate}"
      set -e
      runtime_entry="$(get_runtime_entry)"
    else
      log "xcodes offered no iOS ${REQUIRED_IOS_SIM_RUNTIME_MAJOR}.x runtime"
    fi
  fi

  # Last resort: local DMG
  if [[ -z "${runtime_entry}" && -n "${IOS_RUNTIME_DMG_PATH}" ]]; then
    log "Trying simctl runtime add from DMG: ${IOS_RUNTIME_DMG_PATH}"
    [[ -f "${IOS_RUNTIME_DMG_PATH}" ]] || die "IOS_RUNTIME_DMG_PATH does not exist: ${IOS_RUNTIME_DMG_PATH}"
    xcrun simctl runtime add "${IOS_RUNTIME_DMG_PATH}"
    runtime_entry="$(get_runtime_entry)"
  fi

  [[ -n "${runtime_entry}" ]] \
    || die "Unable to install/find an iOS ${REQUIRED_IOS_SIM_RUNTIME_MAJOR}.x runtime.\nInstalled runtimes:\n$(xcrun simctl list runtimes 2>/dev/null || true)\nInstall one via Xcode > Settings > Platforms, or provide IOS_RUNTIME_DMG_PATH to a runtime DMG."
fi

RUNTIME_VERSION="${runtime_entry%% *}"
runtime_identifier="${runtime_entry##* }"
log "Runtime OK: iOS ${RUNTIME_VERSION} (${runtime_identifier})"

# Boot the default simulator once to warm it up. Scoped to the resolved runtime's
# section of `simctl list devices`, and anchored on "<device type> (" so the
# lookup cannot drift onto a "... Pro Max" device.
default_udid="$(xcrun simctl list devices 2>/dev/null \
  | awk -v want="-- iOS ${RUNTIME_VERSION} --" '
      /^-- / { in_section = ($0 == want); next }
      in_section { print }
    ' \
  | grep -E "^[[:space:]]*${REQUIRED_SIM_DEVICE_TYPE} \(" \
  | grep -oE '[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}' \
  | head -n1 || true)"

if [[ -n "${default_udid}" ]]; then
  log "Warming up simulator: ${REQUIRED_SIM_DEVICE_TYPE} (${default_udid})..."
  xcrun simctl boot "${default_udid}" || true
  xcrun simctl bootstatus "${default_udid}" -b
  xcrun simctl shutdown "${default_udid}" || true
  log "Simulator ready: ${default_udid}"
else
  log "Warning: No ${REQUIRED_SIM_DEVICE_TYPE} simulator found for iOS ${RUNTIME_VERSION}"
fi

# ==================================================
# 2) NVM + Node.js (official installer)
# ==================================================
log "Ensuring NVM and Node ${REQUIRED_NODE_VERSION}..."

if [[ ! -d "$HOME/.nvm" ]]; then
  log "Installing NVM (${NVM_VERSION})..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash
fi

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1090
source "$NVM_DIR/nvm.sh"

ACTUAL_NODE_VERSION="$(node -v 2>/dev/null | sed 's/^v//' || true)"
if [[ "${ACTUAL_NODE_VERSION}" == "${REQUIRED_NODE_VERSION}" ]]; then
  log "Node already at ${REQUIRED_NODE_VERSION} — skipping"
else
  log "Installing Node ${REQUIRED_NODE_VERSION}..."
  nvm install "${REQUIRED_NODE_VERSION}"
  nvm alias default "${REQUIRED_NODE_VERSION}"
  nvm use "${REQUIRED_NODE_VERSION}"

  ACTUAL_NODE_VERSION="$(node -v | sed 's/^v//')"
  [[ "${ACTUAL_NODE_VERSION}" == "${REQUIRED_NODE_VERSION}" ]] \
    || die "Node version mismatch: expected ${REQUIRED_NODE_VERSION}, got ${ACTUAL_NODE_VERSION}"
fi
log "Node OK: ${ACTUAL_NODE_VERSION}"

# ==================================================
# 2b) Remove superseded Node versions
# ==================================================
# Placement matters: `source nvm.sh` above takes no arguments, so nvm auto-uses
# whatever the `default` alias points at. On an un-migrated runner that is the
# legacy version, and `nvm uninstall` on the *active* version returns 1 — which
# would kill the script under `set -e`. Running after the pin block guarantees
# ${REQUIRED_NODE_VERSION} is active first.
nvm_uninstall_if_present() {
  local version="$1"
  local version_dir="${NVM_DIR}/versions/node/v${version}"

  # Exact-path probe — byte-for-byte what nvm_is_version_installed does.
  # `nvm ls` / `nvm version` are NOT safe here: a partial pattern resolves onto a
  # DIFFERENT installed version and still returns 0 (e.g. `22.12` -> v22.12.1),
  # so a shortened version string could uninstall the wrong Node.
  if [[ ! -x "${version_dir}/bin/node" ]]; then
    log "Node ${version} not installed — nothing to remove"
    return 0
  fi

  # Guarantee the target is not the active version, and leave the pin active for
  # the Corepack step below.
  nvm use "${REQUIRED_NODE_VERSION}" >/dev/null || true

  # `if` consumes the exit status: nvm returns 1 for an active version and for
  # bad permissions on the install dir — neither should fail provisioning.
  if nvm uninstall "${version}"; then
    log "Removed Node ${version}"
    REMOVED_NODE_VERSIONS+=("${version}")
  else
    log "Warning: could not remove Node ${version} — continuing"
  fi

  # nvm only prunes a `.cache/bin/<slug>/files` directory, which this layout does
  # not have, so the downloaded tarball would otherwise be stranded.
  rm -rf "${NVM_DIR}/.cache/bin/node-v${version}-"* 2>/dev/null || true
}

REMOVED_NODE_VERSIONS=()
for _legacy_node in "${LEGACY_NODE_VERSIONS[@]}"; do
  nvm_uninstall_if_present "${_legacy_node}"
done
unset _legacy_node

# The runner service reads its PATH from actions-runner/.path, which pins an
# absolute nvm node bin dir. If that file still points at a version just removed,
# the service's PATH is now broken — setup-runner-launchagent.sh rewrites it from
# the nvm default alias, so tell the operator to re-run it.
if (( ${#REMOVED_NODE_VERSIONS[@]} > 0 )); then
  RUNNER_PATH_FILE="${RUNNER_DIR:-$HOME/actions-runner}/.path"
  for _removed_node in "${REMOVED_NODE_VERSIONS[@]}"; do
    if [[ -f "${RUNNER_PATH_FILE}" ]] && grep -Fq "versions/node/v${_removed_node}/" "${RUNNER_PATH_FILE}"; then
      log "Warning: ${RUNNER_PATH_FILE} still references the removed Node v${_removed_node}.\n  The runner service PATH is now stale — re-run setup-runner-launchagent.sh to rewrite it."
    fi
  done
  unset _removed_node
fi

# Re-assert the default alias. nvm's own alias cleanup on uninstall is a no-op
# (its glob is double-quoted, so the loop never runs), which leaves `default`
# pointing at the version just deleted. setup-runner-launchagent.sh resolves that
# alias and hard-fails if it dangles.
if [[ -x "${NVM_DIR}/versions/node/v${REQUIRED_NODE_VERSION}/bin/node" ]]; then
  nvm alias default "${REQUIRED_NODE_VERSION}" >/dev/null
  log "nvm default alias -> v${REQUIRED_NODE_VERSION}"
else
  log "Warning: Node v${REQUIRED_NODE_VERSION} is not managed by nvm — leaving default alias untouched"
fi

# ==================================================
# Corepack (yarn shim)
# ==================================================
# actions/setup-node resolves Node from the runner's tool cache, never from nvm,
# and `cache: yarn` looks up `yarn` on PATH inside its own step — before a
# workflow's own `corepack enable` step gets a chance to run. setup-node only
# *prepends* the tool-cache bin dir, so the lookup falls through to the rest of
# PATH and finds the shim below. The shim then execs under whichever Node
# setup-node activated, and resolves the yarn version from the repo's own
# packageManager field — so .nvmrc stays the single source of truth for Node.
#
# The shim goes in Homebrew's bin rather than the nvm bin dir on purpose: that
# path is already on the runner's .path (setup-runner-launchagent.sh) and does
# not move when the Node pin changes, so bumping REQUIRED_NODE_VERSION never
# strands the shim outside the runner's PATH.
COREPACK_SHIM_DIR="$(brew --prefix)/bin"
log "Enabling Corepack (shims -> ${COREPACK_SHIM_DIR})..."

corepack enable --install-directory "${COREPACK_SHIM_DIR}"

YARN_SHIM="${COREPACK_SHIM_DIR}/yarn"
[[ -x "${YARN_SHIM}" ]] || die "Corepack enable failed: yarn shim not found at ${YARN_SHIM}"
log "Corepack OK: yarn shim at ${YARN_SHIM}"

# ==================================================
# 3) applesimutils (MUST be before Ruby)
# ==================================================
log "Ensuring applesimutils..."
if command_exists applesimutils; then
  log "applesimutils already installed — skipping"
else
  brew tap wix/brew
  brew install applesimutils
  command_exists applesimutils || die "applesimutils installation failed"
fi
log "applesimutils OK"

# ==================================================
# 4) Ruby via rbenv
# ==================================================
log "Ensuring rbenv and Ruby ${REQUIRED_RUBY_VERSION}..."

if ! command_exists rbenv; then
  log "Installing rbenv and ruby-build..."
  brew install rbenv ruby-build openssl@1.1 || true
else
  log "rbenv already installed — skipping brew install"
fi

export PATH="$HOME/.rbenv/shims:$HOME/.rbenv/bin:$PATH"
eval "$(rbenv init - bash)"
rbenv rehash 2>/dev/null || true

if ! rbenv versions --bare | grep -Fxq "${REQUIRED_RUBY_VERSION}"; then
  log "Installing Ruby ${REQUIRED_RUBY_VERSION} (this may take a while)..."
  OPENSSL_DIR="$(brew --prefix openssl@1.1)"
  RUBY_CONFIGURE_OPTS="--with-openssl-dir=${OPENSSL_DIR} --disable-shared" \
    rbenv install "${REQUIRED_RUBY_VERSION}"
else
  log "Ruby ${REQUIRED_RUBY_VERSION} already installed via rbenv — skipping build"
fi

rbenv global "${REQUIRED_RUBY_VERSION}"
rbenv rehash

# Ensure rbenv is available in future zsh sessions (GitHub Actions runner shell)
RBENV_PATH_LINE='export PATH="$HOME/.rbenv/shims:$HOME/.rbenv/bin:$PATH"'
RBENV_INIT='eval "$(rbenv init - zsh)"'
for rcfile in "$HOME/.zshrc" "$HOME/.zprofile"; do
  if ! grep -Fq '.rbenv' "${rcfile}" 2>/dev/null; then
    echo "${RBENV_PATH_LINE}" >> "${rcfile}"
    echo "${RBENV_INIT}" >> "${rcfile}"
    log "Added rbenv PATH and init to ${rcfile}"
  fi
done

# Validate rbenv shims are active and correct version is running
if [[ "$(command -v ruby)" != "$HOME/.rbenv/shims/ruby" ]]; then
  die "rbenv is not active: ruby resolves to '$(command -v ruby)'"
fi

ACTUAL_RUBY_VERSION="$(ruby -v | awk '{print $2}')"
[[ "${ACTUAL_RUBY_VERSION}" == "${REQUIRED_RUBY_VERSION}"* ]] \
  || die "Ruby runtime mismatch: expected ${REQUIRED_RUBY_VERSION}, got ${ACTUAL_RUBY_VERSION}"
log "Ruby OK: ${ACTUAL_RUBY_VERSION}"

# ==================================================
# 5) CocoaPods (exact version)
# ==================================================
log "Ensuring CocoaPods ${REQUIRED_COCOAPODS_VERSION}..."

ACTUAL_COCOAPODS_VERSION="$(pod --version 2>/dev/null || true)"
if [[ "${ACTUAL_COCOAPODS_VERSION}" == "${REQUIRED_COCOAPODS_VERSION}" ]]; then
  log "CocoaPods already at ${REQUIRED_COCOAPODS_VERSION} — skipping"
else
  log "Installing CocoaPods ${REQUIRED_COCOAPODS_VERSION}..."
  gem install bundler --no-document || true
  gem install cocoapods -v "${REQUIRED_COCOAPODS_VERSION}" --no-document
  rbenv rehash

  ACTUAL_COCOAPODS_VERSION="$(pod --version)"
  [[ "${ACTUAL_COCOAPODS_VERSION}" == "${REQUIRED_COCOAPODS_VERSION}" ]] \
    || die "CocoaPods version mismatch: expected ${REQUIRED_COCOAPODS_VERSION}, got ${ACTUAL_COCOAPODS_VERSION}"
fi
log "CocoaPods OK: ${ACTUAL_COCOAPODS_VERSION}"

# ==================================================
# 6) Summary
# ==================================================
log "Bootstrap complete ✅"
cat <<EOF

Locked versions:
- macOS           : ${MACOS_VERSION}
- Xcode           : ${ACTUAL_XCODE_VERSION}
- Node            : ${ACTUAL_NODE_VERSION}
- Yarn (corepack) : ${YARN_SHIM}
- Ruby            : ${ACTUAL_RUBY_VERSION}
- CocoaPods       : ${ACTUAL_COCOAPODS_VERSION}
- applesimutils   : $(applesimutils --version 2>/dev/null || echo "installed")
- Simulator       : ${REQUIRED_SIM_DEVICE_TYPE} (${default_udid:-none})
- Runtime         : iOS ${RUNTIME_VERSION} (${runtime_identifier})

Removed if present: Xcode ${LEGACY_XCODE_VERSIONS[*]}, Node ${LEGACY_NODE_VERSIONS[*]}

To use the installed tools in your current shell, run:
  source ~/.zshrc
Or open a new terminal session.

EOF

#!/usr/bin/env bash
set -euo pipefail

# ==================================================
# REQUIRED VERSIONS (FAIL IF NOT EXACT)
# ==================================================
REQUIRED_XCODE_VERSION="26.0"
REQUIRED_NODE_VERSION="24.16.0"
REQUIRED_RUBY_VERSION="3.1.2"
REQUIRED_COCOAPODS_VERSION="1.16.2"
NVM_VERSION="v0.40.4"

# Simulator pinning
REQUIRED_IOS_SIM_RUNTIME_NAME="iOS 26.0"
REQUIRED_SIM_DEVICE_TYPE="iPhone 17 Pro"
CI_SIM_NAME="CI iPhone 17 Pro (26.0)"
# Optional escape hatch if runtime install isn't supported automatically:
# Provide a local path to a downloaded runtime DMG
# Example: export IOS_RUNTIME_DMG_PATH="/path/to/iOS_26.0_Simulator_Runtime.dmg"
IOS_RUNTIME_DMG_PATH="${IOS_RUNTIME_DMG_PATH:-}"

# Preferred Xcode install path: a URL to Xcode_26.0.xip (e.g. presigned S3 URL,
# set automatically by the fleet dashboard). Installing from a xip requires NO
# Apple ID — xip(1) verifies Apple's signature on the archive. When unset, the
# script falls back to xcodes + XCODE_APPLE_ID/XCODE_APPLE_ID_PASSWORD.
XCODE_XIP_URL="${XCODE_XIP_URL:-}"

# ==================================================
# Helpers
# ==================================================
log() { echo -e "\n\033[1;34m==>\033[0m $*"; }
die() { echo -e "\n\033[1;31mERROR:\033[0m $*" >&2; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

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
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Set up PATH after fresh install
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  else
    die "Homebrew installed but brew not found on PATH"
  fi
fi

brew update

# ==================================================
# Xcode install — xip mode (no Apple auth) with xcodes fallback
# ==================================================
log "Ensuring Xcode ${REQUIRED_XCODE_VERSION} is installed..."

XCODE_ALREADY_INSTALLED=false
if command_exists xcodebuild; then
  CURRENT_XCODE_VERSION="$(xcodebuild -version 2>/dev/null | head -n1 | awk '{print $2}' || true)"
  if [[ "${CURRENT_XCODE_VERSION}" == "${REQUIRED_XCODE_VERSION}" ]]; then
    log "Xcode ${REQUIRED_XCODE_VERSION} is already selected — skipping install"
    XCODE_ALREADY_INSTALLED=true
  fi
fi

if [[ "${XCODE_ALREADY_INSTALLED}" == false ]]; then
  TARGET_APP="/Applications/Xcode-${REQUIRED_XCODE_VERSION}.app"
  if [[ -d "${TARGET_APP}" ]]; then
    log "Found existing ${TARGET_APP}"
  elif [[ -n "${XCODE_XIP_URL}" ]]; then
    log "Downloading Xcode ${REQUIRED_XCODE_VERSION} xip (no Apple auth needed)..."
    curl -fL --retry 3 -o /tmp/Xcode.xip "${XCODE_XIP_URL}"
    log "Expanding xip (verifies Apple signature; takes a while)..."
    (cd /tmp && xip --expand Xcode.xip)
    mv /tmp/Xcode.app "${TARGET_APP}"
    rm -f /tmp/Xcode.xip
  else
    # Fallback: xcodes with Apple ID (may require interactive 2FA)
    if [[ -z "${XCODE_APPLE_ID:-}" || -z "${XCODE_APPLE_ID_PASSWORD:-}" ]]; then
      die "No XCODE_XIP_URL and no Apple ID env vars — cannot install Xcode"
    fi
    export XCODES_USERNAME="${XCODE_APPLE_ID}"
    export XCODES_PASSWORD="${XCODE_APPLE_ID_PASSWORD}"

    # Install xcodes if missing (use pre-built binary — brew formula requires
    # Xcode to compile from source, which defeats the purpose)
    if ! command_exists xcodes; then
      log "Installing xcodes (pre-built binary)..."
      curl -sL "https://github.com/XcodesOrg/xcodes/releases/latest/download/xcodes.zip" -o /tmp/xcodes.zip
      unzip -o /tmp/xcodes.zip -d /tmp
      install -m 755 /tmp/xcodes "$(brew --prefix)/bin/xcodes"
      rm -f /tmp/xcodes.zip /tmp/xcodes
    fi

    log "Downloading and installing Xcode ${REQUIRED_XCODE_VERSION} via xcodes..."
    xcodes install "${REQUIRED_XCODE_VERSION}"
    for app in /Applications/Xcode*"${REQUIRED_XCODE_VERSION}"*.app; do
      if [[ -d "$app" && "$app" != "${TARGET_APP}" ]]; then
        mv "$app" "${TARGET_APP}"
        break
      fi
    done
  fi
  [[ -d "${TARGET_APP}" ]] || die "Xcode install failed: ${TARGET_APP} not found"
  sudo xcode-select -s "${TARGET_APP}/Contents/Developer"
fi

# Accept license (required for xcodebuild, CocoaPods, etc.)
sudo xcodebuild -license accept

# Install required system packages (CoreSimulator, simctl, etc.)
# This is critical: if a previous install was interrupted (e.g. SSH timeout),
# the Xcode app may exist but system components will be missing.
log "Installing Xcode first-launch system packages..."
sudo xcodebuild -runFirstLaunch

# ==================================================
# Validate Xcode version (FAIL FAST)
# ==================================================
ACTUAL_XCODE_VERSION="$(xcodebuild -version | head -n1 | awk '{print $2}')"
[[ "${ACTUAL_XCODE_VERSION}" == "${REQUIRED_XCODE_VERSION}" ]] \
  || die "Xcode version mismatch: expected ${REQUIRED_XCODE_VERSION}, got ${ACTUAL_XCODE_VERSION}"
log "Xcode OK: ${ACTUAL_XCODE_VERSION}"

# Validate Xcode components are functional (catches partial installs)
if ! xcrun simctl list devicetypes >/dev/null 2>&1; then
  die "Xcode ${REQUIRED_XCODE_VERSION} appears broken (simctl not functional). Remove it and re-run this script:\n  sudo rm -rf /Applications/Xcode-${REQUIRED_XCODE_VERSION}*.app"
fi

# ==================================================
# Simulator runtime + device (${REQUIRED_SIM_DEVICE_TYPE} / ${REQUIRED_IOS_SIM_RUNTIME_NAME})
# ==================================================
log "Ensuring simulator runtime '${REQUIRED_IOS_SIM_RUNTIME_NAME}' and device '${CI_SIM_NAME}' exist..."

# Ensure the device type exists in this Xcode
if ! xcrun simctl list devicetypes | grep -Fq "${REQUIRED_SIM_DEVICE_TYPE}"; then
  die "Simulator device type '${REQUIRED_SIM_DEVICE_TYPE}' not found in this Xcode. Check Xcode version/components."
fi

get_runtime_id() {
  xcrun simctl list runtimes \
    | grep -F "${REQUIRED_IOS_SIM_RUNTIME_NAME}" \
    | grep -oE 'com\.apple\.CoreSimulator\.SimRuntime\.[A-Za-z0-9.\-]+' \
    | head -n1 || true
}

runtime_identifier="$(get_runtime_id)"

if [[ -z "${runtime_identifier}" ]]; then
  log "Runtime '${REQUIRED_IOS_SIM_RUNTIME_NAME}' not installed yet."

  # Primary method: xcodebuild -downloadPlatform (Apple's native approach, no Apple ID needed)
  log "Downloading iOS platform via xcodebuild..."
  set +e
  xcodebuild -downloadPlatform iOS
  set -e
  runtime_identifier="$(get_runtime_id)"

  # Fallback: xcodes runtimes install (only if xcodes is available)
  if [[ -z "${runtime_identifier}" ]] && command_exists xcodes; then
    log "xcodebuild download did not work — falling back to xcodes..."
    set +e
    xcodes runtimes install "${REQUIRED_IOS_SIM_RUNTIME_NAME}"
    set -e
    runtime_identifier="$(get_runtime_id)"
  fi

  # Last resort: local DMG
  if [[ -z "${runtime_identifier}" && -n "${IOS_RUNTIME_DMG_PATH}" ]]; then
    log "Trying simctl runtime add from DMG: ${IOS_RUNTIME_DMG_PATH}"
    [[ -f "${IOS_RUNTIME_DMG_PATH}" ]] || die "IOS_RUNTIME_DMG_PATH does not exist: ${IOS_RUNTIME_DMG_PATH}"
    xcrun simctl runtime add "${IOS_RUNTIME_DMG_PATH}"
    runtime_identifier="$(get_runtime_id)"
  fi

  [[ -n "${runtime_identifier}" ]] || die "Unable to install/find runtime '${REQUIRED_IOS_SIM_RUNTIME_NAME}'. Install it in Xcode > Settings > Platforms, or provide IOS_RUNTIME_DMG_PATH to a runtime DMG."
fi

log "Runtime OK: ${runtime_identifier}"

# Boot the default simulator once to warm it up
set +eo pipefail
default_udid="$(xcrun simctl list devices \
  | grep "${REQUIRED_SIM_DEVICE_TYPE}" \
  | grep -oE '[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}' \
  | head -n1)"
set -eo pipefail

if [[ -n "${default_udid}" ]]; then
  log "Warming up default simulator: ${REQUIRED_SIM_DEVICE_TYPE} (${default_udid})..."
  xcrun simctl boot "${default_udid}" || true
  xcrun simctl bootstatus "${default_udid}" -b
  xcrun simctl shutdown "${default_udid}" || true
  log "Simulator ready: ${default_udid}"
else
  log "Warning: No ${REQUIRED_SIM_DEVICE_TYPE} simulator found for ${REQUIRED_IOS_SIM_RUNTIME_NAME}"
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
- Xcode           : ${ACTUAL_XCODE_VERSION}
- Node            : ${ACTUAL_NODE_VERSION}
- Yarn (corepack) : ${YARN_SHIM}
- Ruby            : ${ACTUAL_RUBY_VERSION}
- CocoaPods       : ${ACTUAL_COCOAPODS_VERSION}
- applesimutils   : $(applesimutils --version 2>/dev/null || echo "installed")
- Simulator       : ${REQUIRED_SIM_DEVICE_TYPE} (${default_udid:-none})
- Runtime         : ${REQUIRED_IOS_SIM_RUNTIME_NAME} (${runtime_identifier})

To use the installed tools in your current shell, run:
  source ~/.zshrc
Or open a new terminal session.

EOF
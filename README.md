## Bootstrap a macOS self-hosted runner

This script provisions a fresh macOS machine as a GitHub Actions self-hosted runner. It installs and pins Homebrew, Xcode, iOS simulator runtimes, Node.js (via NVM), Ruby (via rbenv), and CocoaPods to exact versions required by the project. The script is idempotent — if it fails mid-way or is run again, it skips steps that are already complete.

A single pinned Xcode is installed and selected as the system default. Superseded toolchains left behind by earlier runs of this script — **Xcode 16.4, Xcode 26.0 and Node 22.12.0** — are removed automatically so runners do not accumulate multi-gigabyte leftovers. Only those exact versions are touched; anything else installed on a runner is left alone.

### Requirements

**macOS 26.2 or later.** Xcode 26.4 raised the minimum from macOS 15.6, so a runner on an older macOS cannot run the pinned Xcode. The script checks this up front and fails before downloading anything.

**Nothing else.** The Command Line Tools (`git`, `clang`) are installed non-interactively via `softwareupdate` as the very first step, before Homebrew. This matters on a host that already has Homebrew from some other source: the script skips the Homebrew installer when `brew` exists, and that installer is normally what pulls the Command Line Tools in, so without this step such a host reaches `brew update` with no working `git` at all.

### Prerequisites

If Xcode is not already installed, the script uses [xcodes](https://github.com/XcodesOrg/xcodes) to download and install it. This requires an Apple ID. Export the following environment variables before running the script:

```bash
export XCODE_APPLE_ID="your@apple.id"
export XCODE_APPLE_ID_PASSWORD="your-apple-id-password"  # your regular Apple ID password
```

If Xcode is already installed at the required version, these variables are not needed.

### Pinned versions

| Tool | Version |
|------|---------|
| Xcode | 26.6 |
| Node.js | 24.16.0 |
| Yarn | via Corepack shim (version comes from each repo's `packageManager`) |
| Ruby | 3.1.2 |
| CocoaPods | 1.16.2 |
| iOS Simulator | runtime matching the Xcode iOS SDK — 26.5 for Xcode 26.6 (iPhone 17 Pro) |

The simulator runtime version is not hardcoded: the script reads the selected Xcode's iOS SDK version (`xcrun --sdk iphoneos --show-sdk-version`) and requires exactly that runtime. Apple does not keep runtime versions in step with Xcode minor versions — Xcode 26.6 ships the iOS 26.5 SDK and no "iOS 26.6" runtime exists — so a hardcoded minor would drift on every Xcode bump.

The pinned `iPhone 17 Pro` device is created on that runtime if it is missing — a hole `simctl delete unavailable` or a manual simulator purge can leave — and the script fails rather than handing back a runner with nothing to boot.

Once the required runtime is confirmed present, the script deletes every other iOS runtime disk image (~8 GB each) and then runs `simctl delete unavailable` to drop devices whose runtime no longer exists. Nothing else reclaims these: runtime images live outside the Xcode bundle, so the one an uninstalled Xcode pulled in would otherwise sit on disk forever, along with the data directory of every device stranded on it. Only iOS images are touched — watchOS/tvOS/visionOS are left alone — and the required image is identified by build number, not version, because `simctl list runtimes` and `simctl runtime list` disagree on the version column for patch releases.

Matching the version exactly matters beyond the simulator: Xcode reports its whole iOS platform as *not installed* unless the runtime matching its SDK is present, and that makes every iOS destination ineligible — including the `Any iOS Device` placeholder behind `xcodebuild archive -destination 'generic/platform=iOS'`. A runner with only a mismatched runtime (say iOS 26.0 left behind by a superseded Xcode) still builds and tests on a simulator, so it looks healthy, while every Fastlane device build fails with `iOS 26.5 is not installed. Please download and install the platform from Xcode > Settings > Components.` The script installs the matching runtime via `sudo xcodebuild -downloadPlatform iOS` and hard-fails if it cannot, rather than handing over a runner that can only build for the simulator.

Ruby 3.1.2 is pinned by [`real-app`](https://github.com/Realtyka/real-app)'s `.ruby-version`, and **cannot be compiled on macOS 26 unpatched**. Ruby 3.0.x and 3.1.x hardcode `File.read("/usr/include/netinet6/in6.h")` in `ext/socket/extconf.rb`, but macOS 26 ships no `/usr/include` at all — the system headers live only inside the SDK — so that read raises and `extconf.rb` aborts. A failed extension is not fatal to a Ruby build: `make install` still succeeds and `rbenv install` still exits 0, leaving a Ruby that reports the right version from `ruby -v` but has no `socket` extension, after which every `gem install` dies with `cannot load such file -- socket`. That is a build-time problem only — a Ruby 3.1.2 compiled on an older macOS keeps working after an OS upgrade, which is why runners provisioned before macOS 26 are unaffected. Ruby 3.2 fixed this upstream by resolving the header's real location; the script backports that fix as a patch applied through `rbenv install --patch`, and only for versions that still carry the bug (3.1.7, the final 3.1 release, still does).

Because a broken Ruby satisfies both `rbenv versions` and `ruby -v`, the script gates the build on whether the install can actually load `socket`, `openssl`, `zlib` and `psych` — not on whether it exists — and rebuilds in place with `--force` when it cannot. `--force` rather than an uninstall-then-install: `ruby-build` only runs `make install` after a successful compile, so a failed rebuild leaves the existing install untouched instead of stranding the runner with no Ruby at all.

OpenSSL is resolved at build time rather than pinned to `openssl@1.1`, which Homebrew disabled on 2024-10-24. Machines that still have it keep using it, so existing runners build exactly what they built before; anything else falls back to `openssl@3`, which Ruby 3.1 supports. A bare `brew --prefix openssl@1.1` is deliberately avoided — it exits non-zero for a formula that is not installed, and under `set -e` that killed the whole run mid-provision.

### Usage

```bash
curl -fsSL https://raw.githubusercontent.com/Realtyka/bootstrap-self-hosted-mac-runner/main/bootstrap-macos-runner.sh -o /tmp/bootstrap-macos-runner.sh && bash /tmp/bootstrap-macos-runner.sh
```

> **Note:** The script runs interactively. It will prompt for your `sudo` password (for Homebrew and Xcode license acceptance) and may ask for confirmation during certain install steps. Stay at the terminal and watch for prompts.

### Managing runner labels

To add or remove labels from the self-hosted runner, go to **Settings → Actions → Runners** in the repository:

<https://github.com/Realtyka/real-app/settings/actions/runners>

Click the runner, then edit its labels as needed.

### Set up runner as LaunchAgent

A GitHub Actions runner installed as a LaunchDaemon runs outside any GUI session, which means macOS user keychains are not available. This causes fastlane's `setup_ci` / `match` / codesign to fail silently. The `setup-runner-launchagent.sh` script sets up the runner as a LaunchAgent so it runs inside the logged-in user's GUI session where keychain operations work normally. If an existing LaunchDaemon is found, it will be converted; otherwise a fresh LaunchAgent plist is created.

> **Re-run this after any bootstrap run that changes the Node version.** The runner service reads its PATH from `actions-runner/.path`, which pins an absolute nvm node bin directory. Removing the old Node leaves that file pointing at a directory that no longer exists; this script rewrites it from the nvm `default` alias. `bootstrap-macos-runner.sh` warns when it detects this.

```bash
curl -fsSL https://raw.githubusercontent.com/Realtyka/bootstrap-self-hosted-mac-runner/main/setup-runner-launchagent.sh -o /tmp/setup-runner-launchagent.sh && bash /tmp/setup-runner-launchagent.sh
```

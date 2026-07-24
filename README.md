## Bootstrap a macOS self-hosted runner

This script provisions a fresh macOS machine as a GitHub Actions self-hosted runner. It installs and pins Homebrew, Xcode, iOS simulator runtimes, Node.js (via NVM), Ruby (via rbenv), and CocoaPods to exact versions required by the project. The script is idempotent — if it fails mid-way or is run again, it skips steps that are already complete.

Xcode and Node.js are each installed in two versions: a pinned default, plus an additional version installed alongside (not selected as default). This lets workflows that pin an older toolchain and workflows migrating to a newer one both run on the same runner during a transition period.

### Prerequisites

**Preferred (no Apple auth):** provide a URL to `Xcode_26.0.xip` — for example a presigned S3 URL. The [fleet dashboard](dashboard/) sets this automatically for every bootstrap job:

```bash
export XCODE_XIP_URL="https://<presigned-s3-url>/Xcode_26.0.xip"
```

`xip --expand` verifies Apple's signature on the archive, so no Apple ID ever touches the machine. Simulator runtimes are fetched with `xcodebuild -downloadPlatform iOS`, which also needs no Apple ID.

**Fallback:** if `XCODE_XIP_URL` is unset, the script uses [xcodes](https://github.com/XcodesOrg/xcodes), which requires an Apple ID (and may prompt for a 2FA code interactively):

```bash
export XCODE_APPLE_ID="your@apple.id"
export XCODE_APPLE_ID_PASSWORD="your-apple-id-password"  # your regular Apple ID password
```

If Xcode is already installed at the required version, neither is needed.

### Pinned versions

| Tool | Version |
|------|---------|
| Xcode | 26.0 |
| Node.js | 24.16.0 |
| Yarn | via Corepack shim (version comes from each repo's `packageManager`) |
| Ruby | 3.1.2 |
| CocoaPods | 1.16.2 |
| iOS Simulator | iOS 26.0 (iPhone 17 Pro) |

### Usage

```bash
curl -fsSL https://raw.githubusercontent.com/Realtyka/bootstrap-self-hosted-mac-runner/main/bootstrap-macos-runner.sh -o /tmp/bootstrap-macos-runner.sh && bash /tmp/bootstrap-macos-runner.sh
```

> **Note:** The script runs interactively. It will prompt for your `sudo` password (for Homebrew and Xcode license acceptance) and may ask for confirmation during certain install steps. Stay at the terminal and watch for prompts.

### Set up runner as LaunchAgent

A GitHub Actions runner installed as a LaunchDaemon runs outside any GUI session, which means macOS user keychains are not available. This causes fastlane's `setup_ci` / `match` / codesign to fail silently. The `setup-runner-launchagent.sh` script sets up the runner as a LaunchAgent so it runs inside the logged-in user's GUI session where keychain operations work normally. If an existing LaunchDaemon is found, it will be converted; otherwise a fresh LaunchAgent plist is created.

```bash
curl -fsSL https://raw.githubusercontent.com/Realtyka/bootstrap-self-hosted-mac-runner/main/setup-runner-launchagent.sh -o /tmp/setup-runner-launchagent.sh && bash /tmp/setup-runner-launchagent.sh
```

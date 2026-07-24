# Mac Fleet Dashboard

Local web dashboard for onboarding, bootstrapping, and monitoring the MacStadium
self-hosted GitHub Actions runner fleet over SSH. Jobs run **detached** on each
Mac — a dropped SSH connection or a closed laptop never kills a bootstrap.

## Setup

```bash
cd dashboard
npm install
cp hosts.example.yaml hosts.yaml     # inventory (gitignored)
cp .env.example .env                 # S3 xip config (gitignored)
```

Upload the Xcode xip once (any machine, Apple auth once, then never again):

```bash
aws s3 cp Xcode_26.0.xip s3://<your-bucket>/Xcode_26.0.xip
```

Set `S3_XIP_URI` in `.env`. The dashboard presigns a download URL per job using
your local AWS credentials — runners never see AWS creds or an Apple ID.

## Run

```bash
npm run build && npm start           # production: http://127.0.0.1:4400
# or during development:
npm run dev                          # api server on :4400
npm run dev:web                      # vite dev server on :5173 (proxies /api)
```

## Onboarding a fresh bare metal

1. Click **+ Onboard host**, enter name, IP, username (`administrator`), password.
2. The app installs your SSH key (`~/.ssh/id_ed25519.pub`), writes a
   `/etc/sudoers.d/mac-fleet` NOPASSWD entry, then verifies key-only login and
   `sudo -n true`. The password is used once, in memory only.
3. Card appears in the grid → select it → **▶ Bootstrap**. Watch live logs in
   the bottom dock. 30–60 min later the card flips green.
4. Run **LaunchAgent** so the GitHub runner lives in a GUI session (keychain
   access for fastlane/match).

## Troubleshooting

- **Job refused: "passwordless sudo missing"** — re-run onboarding for that
  host, or check `/etc/sudoers.d/mac-fleet` on the machine.
- **Job flagged `stalled`** — no output for 15 min. Xcode downloads can look
  quiet; wait, send stdin input, or kill. Nothing is auto-killed.
- **Rescue over plain SSH** — the dock's "Copy rescue cmd" button gives you:
  `ssh <host> 'tail -f ~/.mac-fleet/jobs/<id>/out.log'`
- **Unexpected interactive prompt in a job** (e.g. xcodes 2FA in fallback
  mode) — type the response in the dock input box; it is written to the job's
  stdin FIFO and never recorded.

## Notes

- Binds `127.0.0.1` only. SSH auth = your `~/.ssh/config` + keys; the app
  stores no secrets.
- Job history in `data/fleet.db`; full logs mirrored under `data/logs/`.
- Remote job dirs (`~/.mac-fleet/jobs/<id>/`) are pruned after 14 days.
- Version pins are parsed live from `../bootstrap-macos-runner.sh` — the script
  stays the single source of truth.

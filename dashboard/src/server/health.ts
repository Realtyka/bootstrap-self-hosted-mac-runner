import type { Transport } from './ssh.js';
import type { Pins } from './pins.js';

export interface HealthReport {
  reachable: boolean; sudoOk: boolean; diskFreeGb: number | null;
  versions: { xcode: string | null; node: string | null; ruby: string | null; cocoapods: string | null; applesimutils: string | null };
  simRuntimeOk: boolean; runnerLoaded: boolean; runnerListening: boolean;
  drift: string[]; checkedAt: number;
}

export const PROBE_SCRIPT = `
echo "SUDO=$(sudo -n true 2>/dev/null && echo ok || echo no)"
echo "DISK=$(df -g / | awk 'NR==2 {print $4}')"
echo "XCODE=$(xcodebuild -version 2>/dev/null | head -n1 | awk '{print $2}')"
echo "NODE=$(source ~/.nvm/nvm.sh 2>/dev/null; node -v 2>/dev/null | sed 's/^v//')"
echo "RUBY=$(export PATH="$HOME/.rbenv/shims:$PATH"; ruby -v 2>/dev/null | awk '{print $2}')"
echo "PODS=$(export PATH="$HOME/.rbenv/shims:$PATH"; pod --version 2>/dev/null)"
echo "ASU=$(applesimutils --version 2>/dev/null | awk '{print $NF}')"
echo "RUNTIME=$(xcrun simctl list runtimes 2>/dev/null | grep -c "IOS_RUNTIME_PLACEHOLDER")"
echo "AGENT=$(launchctl list 2>/dev/null | grep -c actions.runner)"
echo "LISTENER=$(pgrep -f Runner.Listener >/dev/null 2>&1 && echo 1 || echo 0)"
`;

function get(out: Record<string, string>, k: string): string | null {
  const v = out[k]?.trim();
  return v ? v : null;
}

export async function probeHost(t: Transport, sshDest: string, pins: Pins): Promise<HealthReport> {
  const empty: HealthReport = {
    reachable: false, sudoOk: false, diskFreeGb: null,
    versions: { xcode: null, node: null, ruby: null, cocoapods: null, applesimutils: null },
    simRuntimeOk: false, runnerLoaded: false, runnerListening: false, drift: [], checkedAt: Date.now(),
  };
  const r = await t.exec(sshDest, PROBE_SCRIPT.replaceAll('IOS_RUNTIME_PLACEHOLDER', pins.simRuntime));
  if (r.code !== 0) return empty;

  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  const versions = {
    xcode: get(out, 'XCODE'), node: get(out, 'NODE'), ruby: get(out, 'RUBY'),
    cocoapods: get(out, 'PODS'), applesimutils: get(out, 'ASU'),
  };
  const drift: string[] = [];
  const want: [keyof typeof versions, string, boolean][] = [
    ['xcode', pins.xcode, false], ['node', pins.node, false],
    ['ruby', pins.ruby, true],
    ['cocoapods', pins.cocoapods, false],
  ];
  for (const [key, pin, prefix] of want) {
    const got = versions[key];
    const ok = got !== null && (prefix ? got.startsWith(pin) : got === pin);
    if (!ok) drift.push(`${key}: want ${pin}, got ${got ?? 'missing'}`);
  }
  if (out['RUNTIME']?.trim() === '0') drift.push(`simRuntime: ${pins.simRuntime} missing`);

  return {
    reachable: true,
    sudoOk: out['SUDO']?.trim() === 'ok',
    diskFreeGb: out['DISK'] ? Number(out['DISK']) : null,
    versions,
    simRuntimeOk: out['RUNTIME']?.trim() !== '0',
    runnerLoaded: out['AGENT']?.trim() !== '0',
    runnerListening: out['LISTENER']?.trim() === '1',
    drift, checkedAt: Date.now(),
  };
}

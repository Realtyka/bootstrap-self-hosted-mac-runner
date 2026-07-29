import { describe, it, expect } from 'vitest';
import { probeHost } from '../src/server/health.js';
import type { Transport, ExecResult } from '../src/server/ssh.js';

const pins = { xcode: '26.0', node: '22.12.0', ruby: '3.1.2', cocoapods: '1.16.2', simRuntime: 'iOS 26.0', simDevice: 'iPhone 17 Pro' };

const okOutput = `SUDO=ok
DISK=412
XCODE=26.0
NODE=22.12.0
RUBY=3.1.2p20
PODS=1.16.2
ASU=0.9.10
RUNTIME=1
AGENT=1
LISTENER=1
`;

function fakeT(result: Partial<ExecResult>): Transport {
  return {
    exec: async () => ({ code: 0, stdout: '', stderr: '', ...result }),
    stream: () => { throw new Error('unused'); },
    scp: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
}

describe('probeHost', () => {
  it('healthy host: no drift', async () => {
    const r = await probeHost(fakeT({ stdout: okOutput }), 'a@b', pins);
    expect(r.reachable).toBe(true);
    expect(r.sudoOk).toBe(true);
    expect(r.diskFreeGb).toBe(412);
    expect(r.drift).toEqual([]);
    expect(r.runnerListening).toBe(true);
  });
  it('flags a 16.4 machine as drifted from the 26.0 pin', async () => {
    const old = okOutput.replace('XCODE=26.0', 'XCODE=16.4');
    const r = await probeHost(fakeT({ stdout: old }), 'a@b', pins);
    expect(r.versions.xcode).toBe('16.4');
    expect(r.drift).toContain('xcode: want 26.0, got 16.4');
  });
  it('flags version drift and missing sudo', async () => {
    const bad = okOutput.replace('NODE=22.12.0', 'NODE=20.11.0').replace('SUDO=ok', 'SUDO=no');
    const r = await probeHost(fakeT({ stdout: bad }), 'a@b', pins);
    expect(r.sudoOk).toBe(false);
    expect(r.drift).toContain('node: want 22.12.0, got 20.11.0');
  });
  it('ruby patch suffix tolerated (3.1.2p20 matches 3.1.2)', async () => {
    const r = await probeHost(fakeT({ stdout: okOutput }), 'a@b', pins);
    expect(r.drift.find(d => d.startsWith('ruby'))).toBeUndefined();
  });
  it('unreachable host', async () => {
    const r = await probeHost(fakeT({ code: 255, stderr: 'Connection refused' }), 'a@b', pins);
    expect(r.reachable).toBe(false);
    expect(r.drift).toEqual([]);
  });
});

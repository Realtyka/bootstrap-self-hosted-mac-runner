import { describe, it, expect, beforeEach } from 'vitest';
import { buildApi } from '../src/server/api.js';
import { Store } from '../src/server/store.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobRefusedError } from '../src/server/jobs.js';

let app: Awaited<ReturnType<typeof buildApi>>, store: Store, hostsPath: string;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'api-'));
  hostsPath = join(dir, 'hosts.yaml');
  writeFileSync(hostsPath, 'hosts:\n  - name: mac-01\n    sshDest: a@b\n    tags: []\n  - name: mac-02\n    sshDest: c@d\n    tags: []\n');
  store = new Store(':memory:', join(dir, 'logs'));
  app = await buildApi({
    store, hostsPath,
    engine: {
      startJob: async ({ host }: any) => {
        if (host.name === 'mac-01') return store.createJob({ id: 'j1', host: host.name, action: 'bootstrap', source: 'github', startedAt: 1 });
        throw new JobRefusedError('passwordless sudo missing');
      },
      sendInput: async () => {}, killJob: async () => {}, on: () => {},
    } as any,
    probe: async () => ({ reachable: true, sudoOk: true, drift: [], checkedAt: 1 } as any),
    presign: async () => 'https://signed.example/xip',
    onboard: async () => [{ step: 'connect', ok: true } as any],
    extraEnv: {},
  });
});

describe('api', () => {
  it('GET /api/hosts merges inventory + health + running job', async () => {
    store.saveHealth('mac-01', JSON.stringify({ reachable: true }), 5);
    const r = await app.inject({ method: 'GET', url: '/api/hosts' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body[0].host.name).toBe('mac-01');
    expect(body[0].health.reachable).toBe(true);
  });
  it('POST /api/jobs returns started and refused per host', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/jobs',
      payload: { hosts: ['mac-01', 'mac-02'], action: 'bootstrap', source: 'github' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.started).toHaveLength(1);
    expect(body.refused).toEqual([{ host: 'mac-02', reason: 'passwordless sudo missing' }]);
  });
  it('GET /api/jobs/:id/log serves plain text', async () => {
    store.createJob({ id: 'j9', host: 'mac-01', action: 'bootstrap', source: 'github', startedAt: 1 });
    store.appendLog('j9', 'line1');
    const r = await app.inject({ method: 'GET', url: '/api/jobs/j9/log' });
    expect(r.body).toBe('line1\n');
  });
  it('GET /api/hosts/:name/jobs returns history', async () => {
    store.createJob({ id: 'j9', host: 'mac-01', action: 'bootstrap', source: 'github', startedAt: 1 });
    const r = await app.inject({ method: 'GET', url: '/api/hosts/mac-01/jobs' });
    expect(r.json()).toHaveLength(1);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemSshTransport } from '../src/server/ssh.js';
import { Store } from '../src/server/store.js';
import { JobEngine, JobRefusedError } from '../src/server/jobs.js';
import type { Host } from '../src/server/types.js';

const host: Host = { name: 'mac-01', sshDest: 'x@fake', tags: [] };
let fakeHome: string, engine: JobEngine, repoRoot: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'home-'));
  process.env.FAKE_HOME = fakeHome;
  repoRoot = mkdtempSync(join(tmpdir(), 'repo-'));
  writeFileSync(join(repoRoot, 'bootstrap-macos-runner.sh'), 'echo bootstrapped');
  engine = new JobEngine({
    transport: new SystemSshTransport({ sshBin: 'test/fixtures/fake-ssh-home.sh', scpBin: 'test/fixtures/fake-scp-home.sh' }),
    store: new Store(':memory:', mkdtempSync(join(tmpdir(), 'logs-'))),
    repoRoot, rawBaseUrl: 'https://example.invalid/raw', pollMs: 50, stallMs: 60_000,
  });
});

describe('startJob', () => {
  it('refuses when sudo -n fails', async () => {
    mkdirSync(join(fakeHome, 'bin'), { recursive: true });
    writeFileSync(join(fakeHome, 'bin', 'sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.FAKE_PATH_PREFIX = join(fakeHome, 'bin');
    await expect(engine.startJob({ host, action: 'bootstrap', source: 'local' }))
      .rejects.toBeInstanceOf(JobRefusedError);
  });
  it('local source: delivers script, env file, job.sh; job runs detached and writes exit_code', async () => {
    mkdirSync(join(fakeHome, 'bin'), { recursive: true });
    writeFileSync(join(fakeHome, 'bin', 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.FAKE_PATH_PREFIX = join(fakeHome, 'bin');
    const job = await engine.startJob({ host, action: 'bootstrap', source: 'local', envVars: { XCODE_XIP_URL: 'https://s3/xip' } });
    const dir = join(fakeHome, '.mac-fleet', 'jobs', job.id);
    expect(existsSync(join(dir, 'script.sh'))).toBe(true);
    expect(existsSync(join(dir, 'job.sh'))).toBe(true);
    await new Promise(r => setTimeout(r, 300));
    expect(readFileSync(join(dir, 'exit_code'), 'utf8').trim()).toBe('0');
    expect(existsSync(join(dir, 'env'))).toBe(false);
  });
});

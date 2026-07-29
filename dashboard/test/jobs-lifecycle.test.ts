import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemSshTransport } from '../src/server/ssh.js';
import { Store } from '../src/server/store.js';
import { JobEngine } from '../src/server/jobs.js';
import type { Host } from '../src/server/types.js';

const host: Host = { name: 'mac-01', sshDest: 'x@fake', tags: [] };
let fakeHome: string, engine: JobEngine, store: Store, repoRoot: string;

function passthruSudo() {
  mkdirSync(join(fakeHome, 'bin'), { recursive: true });
  writeFileSync(join(fakeHome, 'bin', 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.FAKE_PATH_PREFIX = join(fakeHome, 'bin');
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'home-'));
  process.env.FAKE_HOME = fakeHome;
  repoRoot = mkdtempSync(join(tmpdir(), 'repo-'));
  store = new Store(':memory:', mkdtempSync(join(tmpdir(), 'logs-')));
  engine = new JobEngine({
    transport: new SystemSshTransport({ sshBin: 'test/fixtures/fake-ssh-home.sh', scpBin: 'test/fixtures/fake-scp-home.sh' }),
    store, repoRoot, rawBaseUrl: 'unused', pollMs: 50, stallMs: 200,
  });
  passthruSudo();
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await wait(25); }
};

describe('lifecycle', () => {
  it('streams log lines and finalizes passed on exit 0', async () => {
    writeFileSync(join(repoRoot, 'bootstrap-macos-runner.sh'), 'echo one; echo two; exit 0');
    const lines: string[] = [];
    engine.on('log', (e: { jobId: string; line: string }) => lines.push(e.line));
    const job = await engine.startJob({ host, action: 'bootstrap', source: 'local' });
    await until(() => store.getJob(job.id)?.state === 'passed');
    expect(lines).toContain('one');
    expect(readFileSync(store.logPath(job.id), 'utf8')).toContain('two');
    expect(store.getJob(job.id)?.exitCode).toBe(0);
  });
  it('finalizes failed on nonzero exit', async () => {
    writeFileSync(join(repoRoot, 'bootstrap-macos-runner.sh'), 'echo boom; exit 7');
    const job = await engine.startJob({ host, action: 'bootstrap', source: 'local' });
    await until(() => store.getJob(job.id)?.state === 'failed');
    expect(store.getJob(job.id)?.exitCode).toBe(7);
  });
  it('marks silent running job stalled, then running again on output', async () => {
    writeFileSync(join(repoRoot, 'bootstrap-macos-runner.sh'), 'echo start; sleep 1; echo alive; sleep 5');
    const job = await engine.startJob({ host, action: 'bootstrap', source: 'local' });
    await until(() => store.getJob(job.id)?.state === 'stalled');
    await until(() => store.getJob(job.id)?.state === 'running');
  });
  it('sendInput feeds script stdin', async () => {
    writeFileSync(join(repoRoot, 'bootstrap-macos-runner.sh'), 'read -r answer; echo "got:$answer"; exit 0');
    const job = await engine.startJob({ host, action: 'bootstrap', source: 'local' });
    await wait(200);
    await engine.sendInput(job.id, host.sshDest, 'sekret');
    await until(() => store.getJob(job.id)?.state === 'passed');
    const log = readFileSync(store.logPath(job.id), 'utf8');
    expect(log).toContain('got:sekret');
  });
  it('reattachAll finalizes a finished job without duplicating the log mirror', async () => {
    writeFileSync(join(repoRoot, 'bootstrap-macos-runner.sh'), 'echo one; echo two; exit 0');
    const job = await engine.startJob({ host, action: 'bootstrap', source: 'local' });
    await until(() => store.getJob(job.id)?.state === 'passed');
    const before = readFileSync(store.logPath(job.id), 'utf8');
    store.updateJob(job.id, { state: 'running', exitCode: null, finishedAt: null });
    await engine.reattachAll([host]);
    await until(() => store.getJob(job.id)?.state === 'passed');
    await wait(200);
    expect(readFileSync(store.logPath(job.id), 'utf8')).toBe(before);
  });
  it('refuses a second job while one is running on the host', async () => {
    writeFileSync(join(repoRoot, 'bootstrap-macos-runner.sh'), 'sleep 30');
    const job = await engine.startJob({ host, action: 'bootstrap', source: 'local' });
    await expect(engine.startJob({ host, action: 'bootstrap', source: 'local' }))
      .rejects.toThrow(/already running/);
    await engine.killJob(job.id, host.sshDest);
  });
  it('killJob terminates the script process tree and marks killed', async () => {
    writeFileSync(join(repoRoot, 'bootstrap-macos-runner.sh'), 'echo waiting; sleep 60');
    const job = await engine.startJob({ host, action: 'bootstrap', source: 'local' });
    const pidFile = join(fakeHome, '.mac-fleet', 'jobs', job.id, 'script_pid');
    await until(() => {
      try { return readFileSync(pidFile, 'utf8').trim() !== ''; } catch { return false; }
    });
    const scriptPid = Number(readFileSync(pidFile, 'utf8').trim());
    await engine.killJob(job.id, host.sshDest);
    expect(store.getJob(job.id)?.state).toBe('killed');
    await until(() => {
      try { process.kill(scriptPid, 0); return false; } catch { return true; }  // ESRCH = dead
    });
  });
});

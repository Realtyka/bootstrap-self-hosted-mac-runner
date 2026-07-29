import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';

let store: Store;
beforeEach(() => { store = new Store(':memory:', mkdtempSync(join(tmpdir(), 'logs-'))); });

const base = { id: 'j1', host: 'mac-01', action: 'bootstrap' as const, source: 'github' as const, startedAt: 1000 };

describe('Store', () => {
  it('creates job in starting state', () => {
    const j = store.createJob(base);
    expect(j.state).toBe('starting');
    expect(store.getJob('j1')?.host).toBe('mac-01');
  });
  it('updates state and exit code', () => {
    store.createJob(base);
    store.updateJob('j1', { state: 'passed', exitCode: 0, finishedAt: 2000 });
    expect(store.getJob('j1')).toMatchObject({ state: 'passed', exitCode: 0, finishedAt: 2000 });
  });
  it('runningJobs returns starting/running/stalled only', () => {
    store.createJob(base);
    store.createJob({ ...base, id: 'j2' });
    store.updateJob('j2', { state: 'failed', exitCode: 1, finishedAt: 2000 });
    expect(store.runningJobs().map(j => j.id)).toEqual(['j1']);
  });
  it('appendLog writes lines to logPath', () => {
    store.createJob(base);
    store.appendLog('j1', 'hello');
    store.appendLog('j1', 'world');
    expect(readFileSync(store.logPath('j1'), 'utf8')).toBe('hello\nworld\n');
  });
  it('saveHealth/latestHealth round-trips', () => {
    store.saveHealth('mac-01', '{"ok":true}', 123);
    expect(store.latestHealth('mac-01')).toEqual({ report: '{"ok":true}', at: 123 });
  });
});

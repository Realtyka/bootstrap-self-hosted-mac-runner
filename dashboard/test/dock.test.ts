import { describe, it, expect } from 'vitest';
import { dockReducer, emptyDock } from '../src/web/lib/dock.js';

const job = { id: 'j1', host: 'mac-01', action: 'bootstrap', state: 'running' } as any;

describe('dockReducer', () => {
  it('job-started adds tab and activates it', () => {
    const s = dockReducer(emptyDock, { type: 'job-started', job });
    expect(s.tabs).toHaveLength(1);
    expect(s.active).toBe('j1');
  });
  it('log appends and caps at 5000', () => {
    let s = dockReducer(emptyDock, { type: 'job-started', job });
    for (let i = 0; i < 5100; i++) s = dockReducer(s, { type: 'log', jobId: 'j1', line: `l${i}` });
    expect(s.buffers['j1']).toHaveLength(5000);
    expect(s.buffers['j1'].at(-1)).toBe('l5099');
  });
  it('state updates tab state', () => {
    let s = dockReducer(emptyDock, { type: 'job-started', job });
    s = dockReducer(s, { type: 'state', job: { ...job, state: 'passed' } });
    expect(s.tabs[0].state).toBe('passed');
  });
  it('select switches active tab', () => {
    let s = dockReducer(emptyDock, { type: 'job-started', job });
    s = dockReducer(s, { type: 'job-started', job: { ...job, id: 'j2', host: 'mac-02' } });
    expect(s.active).toBe('j2');
    s = dockReducer(s, { type: 'select', jobId: 'j1' });
    expect(s.active).toBe('j1');
  });
  it('close removes tab and buffer', () => {
    let s = dockReducer(emptyDock, { type: 'job-started', job });
    s = dockReducer(s, { type: 'close', jobId: 'j1' });
    expect(s.tabs).toHaveLength(0);
    expect(s.buffers['j1']).toBeUndefined();
    expect(s.active).toBeNull();
  });
  it('hydrate seeds buffer without duplicating tab', () => {
    let s = dockReducer(emptyDock, { type: 'job-started', job });
    s = dockReducer(s, { type: 'hydrate', jobId: 'j1', lines: ['a', 'b'] });
    expect(s.buffers['j1']).toEqual(['a', 'b']);
    expect(s.tabs).toHaveLength(1);
  });
});

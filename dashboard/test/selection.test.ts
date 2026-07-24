import { describe, it, expect } from 'vitest';
import { toggle, eligible } from '../src/web/lib/selection.js';

describe('selection', () => {
  it('toggle adds then removes', () => {
    let s = toggle(new Set<string>(), 'mac-01');
    expect([...s]).toEqual(['mac-01']);
    s = toggle(s, 'mac-01');
    expect(s.size).toBe(0);
  });
  it('eligible excludes running and unreachable hosts', () => {
    const views = [
      { host: { name: 'a' }, health: { reachable: true }, runningJob: null },
      { host: { name: 'b' }, health: { reachable: true }, runningJob: { id: 'j' } },
      { host: { name: 'c' }, health: { reachable: false }, runningJob: null },
      { host: { name: 'd' }, health: null, runningJob: null },
    ] as any[];
    expect(eligible(views, new Set(['a', 'b', 'c', 'd']))).toEqual(['a', 'd']);
  });
});

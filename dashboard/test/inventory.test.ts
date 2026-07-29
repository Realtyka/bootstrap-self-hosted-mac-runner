import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHosts, saveHosts, addHost } from '../src/server/inventory.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inv-')); });

describe('inventory', () => {
  it('loads hosts from yaml', () => {
    const p = join(dir, 'hosts.yaml');
    writeFileSync(p, 'hosts:\n  - name: mac-01\n    sshDest: administrator@10.0.0.1\n    tags: [e2e]\n');
    expect(loadHosts(p)).toEqual([{ name: 'mac-01', sshDest: 'administrator@10.0.0.1', tags: ['e2e'] }]);
  });
  it('returns [] when file missing', () => {
    expect(loadHosts(join(dir, 'nope.yaml'))).toEqual([]);
  });
  it('addHost appends and persists', () => {
    const p = join(dir, 'hosts.yaml');
    addHost(p, { name: 'mac-02', sshDest: 'administrator@10.0.0.2', tags: [] });
    expect(loadHosts(p)).toHaveLength(1);
  });
  it('addHost rejects duplicate name', () => {
    const p = join(dir, 'hosts.yaml');
    addHost(p, { name: 'mac-02', sshDest: 'a@b', tags: [] });
    expect(() => addHost(p, { name: 'mac-02', sshDest: 'c@d', tags: [] })).toThrow(/duplicate/i);
  });
});

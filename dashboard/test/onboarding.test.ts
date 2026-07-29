import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onboardHost } from '../src/server/onboarding.js';
import { loadHosts } from '../src/server/inventory.js';
import type { Transport } from '../src/server/ssh.js';

let calls: { command: string; stdin?: string }[];
let hostsPath: string;

const fakeConnect = async () => ({
  exec: async (command: string, opts?: { stdin?: string }) => {
    calls.push({ command, stdin: opts?.stdin });
    if (command.includes('grep -qF')) return { code: 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  },
  end: () => {},
});
const okVerify: Transport = {
  exec: async () => ({ code: 0, stdout: '', stderr: '' }),
  stream: () => { throw new Error('unused'); },
  scp: async () => ({ code: 0, stdout: '', stderr: '' }),
};

beforeEach(() => {
  calls = [];
  hostsPath = join(mkdtempSync(join(tmpdir(), 'ob-')), 'hosts.yaml');
});

describe('onboardHost', () => {
  it('installs key via stdin, writes sudoers with password on stdin only, adds host on verify', async () => {
    const steps = await onboardHost({
      host: '10.0.0.5', username: 'administrator', password: 'pw123', name: 'mac-05',
      pubKey: 'ssh-ed25519 AAAA test@key', connect: fakeConnect, verifyTransport: okVerify, hostsPath,
    });
    expect(steps.every(s => s.ok)).toBe(true);
    const keyCall = calls.find(c => c.command.includes('authorized_keys') && c.stdin?.includes('ssh-ed25519'));
    expect(keyCall).toBeDefined();
    const sudoCall = calls.find(c => c.command.includes('sudoers.d/mac-fleet'));
    expect(sudoCall?.stdin).toContain('pw123');
    for (const c of calls) expect(c.command).not.toContain('pw123');
    expect(loadHosts(hostsPath)).toEqual([{ name: 'mac-05', sshDest: 'administrator@10.0.0.5', tags: [] }]);
  });
  it('does not add host when key-only verify fails', async () => {
    const badVerify: Transport = { ...okVerify, exec: async () => ({ code: 255, stdout: '', stderr: 'denied' }) };
    const steps = await onboardHost({
      host: '10.0.0.6', username: 'administrator', password: 'pw', name: 'mac-06',
      pubKey: 'ssh-ed25519 AAAA', connect: fakeConnect, verifyTransport: badVerify, hostsPath,
    });
    expect(steps.find(s => s.step === 'verify')?.ok).toBe(false);
    expect(loadHosts(hostsPath)).toEqual([]);
  });
});

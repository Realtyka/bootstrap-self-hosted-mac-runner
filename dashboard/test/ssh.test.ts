import { describe, it, expect } from 'vitest';
import { SystemSshTransport, buildSshArgs } from '../src/server/ssh.js';

describe('buildSshArgs', () => {
  it('includes batch mode, timeout, dest, command — no -t', () => {
    const args = buildSshArgs('administrator@10.0.0.1', 'echo hi');
    expect(args).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', 'administrator@10.0.0.1', 'echo hi']);
    expect(args).not.toContain('-t');
  });
});

describe('SystemSshTransport with fake ssh bin', () => {
  const fake = new SystemSshTransport({ sshBin: 'test/fixtures/fake-ssh.sh' });
  it('exec captures code and stdout', async () => {
    const r = await fake.exec('ignored@host', 'echo out; echo err >&2; exit 3');
    expect(r.code).toBe(3);
    expect(r.stdout.trim()).toBe('out');
    expect(r.stderr.trim()).toBe('err');
  });
  it('stream emits lines and resolves exit code', async () => {
    const lines: string[] = [];
    const h = fake.stream('ignored@host', 'printf "a\\nb\\n"', l => lines.push(l));
    expect(await h.done).toBe(0);
    expect(lines).toEqual(['a', 'b']);
  });
});

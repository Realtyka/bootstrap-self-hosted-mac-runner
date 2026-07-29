import { Client } from 'ssh2';
import { addHost } from './inventory.js';
import type { Transport } from './ssh.js';

export interface OnboardStep { step: 'connect' | 'install-key' | 'sudoers' | 'verify'; ok: boolean; detail?: string }
export interface PasswordConn {
  exec(command: string, opts?: { stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
  end(): void;
}
export type ConnectFn = (p: { host: string; username: string; password: string }) => Promise<PasswordConn>;

export const ssh2Connect: ConnectFn = ({ host, username, password }) =>
  new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on('ready', () => resolve({
        exec: (command, opts) => new Promise((res, rej) => {
          client.exec(command, (err, stream) => {
            if (err) return rej(err);
            let stdout = '', stderr = '';
            stream.on('data', (d: Buffer) => (stdout += d));
            stream.stderr.on('data', (d: Buffer) => (stderr += d));
            stream.on('close', (code: number | null) => res({ code: code ?? -1, stdout, stderr }));
            if (opts?.stdin !== undefined) stream.write(opts.stdin);
            stream.end();
          });
        }),
        end: () => client.end(),
      }))
      .on('error', reject)
      .connect({ host, username, password, readyTimeout: 15_000 });
  });

export async function onboardHost(p: {
  host: string; username: string; password: string; name: string; pubKey: string;
  connect: ConnectFn; verifyTransport: Transport; hostsPath: string;
  onStep?: (s: OnboardStep) => void;
}): Promise<OnboardStep[]> {
  const steps: OnboardStep[] = [];
  const push = (s: OnboardStep) => { steps.push(s); p.onStep?.(s); return s.ok; };

  let conn: PasswordConn;
  try { conn = await p.connect({ host: p.host, username: p.username, password: p.password }); }
  catch (e) { push({ step: 'connect', ok: false, detail: String(e) }); return steps; }
  push({ step: 'connect', ok: true });

  try {
    const have = await conn.exec(`grep -qF '${p.pubKey.trim()}' ~/.ssh/authorized_keys 2>/dev/null`);
    if (have.code !== 0) {
      const r = await conn.exec('mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys', { stdin: p.pubKey.trim() + '\n' });
      if (!push({ step: 'install-key', ok: r.code === 0, detail: r.stderr })) return steps;
    } else push({ step: 'install-key', ok: true, detail: 'already present' });

    const s = await conn.exec(`sudo -S -p '' sh -c 'echo "%admin ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/mac-fleet && chmod 440 /etc/sudoers.d/mac-fleet && visudo -c'`, { stdin: p.password + '\n' });
    if (!push({ step: 'sudoers', ok: s.code === 0, detail: s.stderr })) return steps;
  } finally { conn.end(); }

  const dest = `${p.username}@${p.host}`;
  const v = await p.verifyTransport.exec(dest, 'sudo -n true');
  if (!push({ step: 'verify', ok: v.code === 0, detail: v.stderr })) return steps;
  addHost(p.hostsPath, { name: p.name, sshDest: dest, tags: [] });
  return steps;
}

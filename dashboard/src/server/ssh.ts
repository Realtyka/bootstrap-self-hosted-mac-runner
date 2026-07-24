import { spawn } from 'node:child_process';

export interface ExecResult { code: number; stdout: string; stderr: string }
export const SSH_BASE_ARGS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

export function buildSshArgs(sshDest: string, command: string): string[] {
  return [...SSH_BASE_ARGS, sshDest, command];
}

export interface Transport {
  exec(sshDest: string, command: string, opts?: { stdin?: string }): Promise<ExecResult>;
  stream(sshDest: string, command: string, onLine: (line: string) => void): { kill: () => void; done: Promise<number> };
  scp(localPath: string, sshDest: string, remotePath: string): Promise<ExecResult>;
}

export class SystemSshTransport implements Transport {
  constructor(private bins: { sshBin?: string; scpBin?: string } = {}) {}
  private get ssh() { return this.bins.sshBin ?? 'ssh'; }
  private get scpCmd() { return this.bins.scpBin ?? 'scp'; }

  exec(sshDest: string, command: string, opts?: { stdin?: string }): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.ssh, buildSshArgs(sshDest, command));
      let stdout = '', stderr = '';
      p.stdout.on('data', d => (stdout += d));
      p.stderr.on('data', d => (stderr += d));
      p.on('error', reject);
      p.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
      if (opts?.stdin !== undefined) p.stdin.write(opts.stdin);
      p.stdin.end();
    });
  }

  stream(sshDest: string, command: string, onLine: (line: string) => void) {
    const p = spawn(this.ssh, buildSshArgs(sshDest, command));
    let buf = '';
    p.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    const done = new Promise<number>(res => p.on('close', c => { if (buf) onLine(buf); res(c ?? -1); }));
    return { kill: () => p.kill('SIGTERM'), done };
  }

  scp(localPath: string, sshDest: string, remotePath: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.scpCmd, [...SSH_BASE_ARGS, localPath, `${sshDest}:${remotePath}`]);
      let stdout = '', stderr = '';
      p.stdout.on('data', d => (stdout += d));
      p.stderr.on('data', d => (stderr += d));
      p.on('error', reject);
      p.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }
}

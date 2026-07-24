import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Transport } from './ssh.js';
import type { Store } from './store.js';
import type { Host, Job, JobAction, JobSource } from './types.js';

export const SCRIPT_BY_ACTION: Record<JobAction, string> = {
  bootstrap: 'bootstrap-macos-runner.sh',
  launchagent: 'setup-runner-launchagent.sh',
};

export class JobRefusedError extends Error {}

export interface JobEngineOpts {
  transport: Transport; store: Store; repoRoot: string; rawBaseUrl: string;
  pollMs?: number; stallMs?: number;
}

const JOB_SH = `#!/bin/bash
cd "$(dirname "$0")"
mkfifo stdin.pipe 2>/dev/null || true
exec 3<>stdin.pipe
if [ -f env ]; then . ./env; rm -f env; fi
export NONINTERACTIVE=1
bash script.sh <&3
echo $? > exit_code
`;

export class JobEngine extends EventEmitter {
  private t: Transport; private store: Store;
  private pollMs: number; private stallMs: number;
  private repoRoot: string; private rawBaseUrl: string;

  constructor(o: JobEngineOpts) {
    super();
    this.t = o.transport; this.store = o.store; this.repoRoot = o.repoRoot;
    this.rawBaseUrl = o.rawBaseUrl;
    this.pollMs = o.pollMs ?? 5000; this.stallMs = o.stallMs ?? 15 * 60_000;
  }

  private dir(id: string) { return `~/.mac-fleet/jobs/${id}`; }

  async startJob(p: { host: Host; action: JobAction; source: JobSource; envVars?: Record<string, string> }): Promise<Job> {
    const { host, action, source } = p;
    const pre = await this.t.exec(host.sshDest, 'sudo -n true');
    if (pre.code !== 0) throw new JobRefusedError('passwordless sudo missing — re-run onboarding');

    const id = randomUUID();
    const d = this.dir(id);
    await this.t.exec(host.sshDest,
      `mkdir -p ${d} && find ~/.mac-fleet/jobs -maxdepth 1 -mindepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null; true`);

    const script = SCRIPT_BY_ACTION[action];
    if (source === 'github') {
      const r = await this.t.exec(host.sshDest, `curl -fsSL ${this.rawBaseUrl}/${script} -o ${d}/script.sh`);
      if (r.code !== 0) throw new Error(`script download failed: ${r.stderr}`);
    } else {
      const r = await this.t.scp(join(this.repoRoot, script), host.sshDest, `${d}/script.sh`);
      if (r.code !== 0) throw new Error(`scp failed: ${r.stderr}`);
    }

    const envLines = Object.entries(p.envVars ?? {})
      .map(([k, v]) => `export ${k}='${v.replaceAll("'", `'\\''`)}'`).join('\n');
    if (envLines) await this.t.exec(host.sshDest, `umask 077 && cat > ${d}/env`, { stdin: envLines + '\n' });
    await this.t.exec(host.sshDest, `cat > ${d}/job.sh`, { stdin: JOB_SH });

    const job = this.store.createJob({ id, host: host.name, action, source, startedAt: Date.now() });
    const launch = await this.t.exec(host.sshDest, `cd ${d} && nohup bash job.sh > out.log 2>&1 & echo $! > ${d}/pid`);
    if (launch.code !== 0) {
      this.store.updateJob(id, { state: 'failed', exitCode: -1, finishedAt: Date.now() });
      throw new Error(`launch failed: ${launch.stderr}`);
    }
    this.store.updateJob(id, { state: 'running' });
    const running = this.store.getJob(id)!;
    this.emit('state', running);
    this.attach(running, host.sshDest);
    return running;
  }

  // replaced with full implementation in lifecycle work (Task 6)
  attach(_job: Job, _sshDest: string): void {}
}

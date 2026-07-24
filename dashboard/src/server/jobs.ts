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
    // Brace group is load-bearing: `cd && nohup ... & echo` would background the
    // whole chain as a subshell whose stdout keeps the ssh channel open until the
    // script finishes. Only nohup itself may be backgrounded.
    const launch = await this.t.exec(host.sshDest, `cd ${d} && { nohup bash job.sh < /dev/null > out.log 2>&1 & echo $! > pid; }`);
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

  private tails = new Map<string, { kill: () => void }>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private lastLineAt = new Map<string, number>();

  attach(job: Job, sshDest: string): void {
    const d = this.dir(job.id);
    this.lastLineAt.set(job.id, Date.now());
    const tail = this.t.stream(sshDest, `tail -n +1 -F ${d}/out.log 2>/dev/null`, line => {
      this.lastLineAt.set(job.id, Date.now());
      this.store.appendLog(job.id, line);
      const cur = this.store.getJob(job.id);
      if (cur?.state === 'stalled') {
        this.store.updateJob(job.id, { state: 'running' });
        this.emit('state', this.store.getJob(job.id));
      }
      this.emit('log', { jobId: job.id, line });
    });
    this.tails.set(job.id, tail);

    const timer = setInterval(async () => {
      const r = await this.t.exec(sshDest, `cat ${d}/exit_code 2>/dev/null`);
      const cur = this.store.getJob(job.id);
      if (!cur || ['passed', 'failed', 'killed'].includes(cur.state)) { this.detach(job.id); return; }
      if (r.code === 0 && r.stdout.trim() !== '') {
        const code = Number(r.stdout.trim());
        this.store.updateJob(job.id, { state: code === 0 ? 'passed' : 'failed', exitCode: code, finishedAt: Date.now() });
        this.emit('state', this.store.getJob(job.id));
        this.detach(job.id);
        return;
      }
      if (cur.state === 'running' && Date.now() - (this.lastLineAt.get(job.id) ?? 0) > this.stallMs) {
        this.store.updateJob(job.id, { state: 'stalled' });
        this.emit('state', this.store.getJob(job.id));
      }
    }, this.pollMs);
    this.timers.set(job.id, timer);
  }

  private detach(id: string): void {
    this.tails.get(id)?.kill(); this.tails.delete(id);
    const t = this.timers.get(id); if (t) clearInterval(t); this.timers.delete(id);
    this.lastLineAt.delete(id);
  }

  async reattachAll(hosts: Host[]): Promise<void> {
    const byName = new Map(hosts.map(h => [h.name, h]));
    for (const job of this.store.runningJobs()) {
      const host = byName.get(job.host);
      if (!host) continue;
      this.attach(job, host.sshDest);
    }
  }

  async sendInput(jobId: string, hostDest: string, text: string): Promise<void> {
    // via stdin so the value never appears in argv or our logs
    await this.t.exec(hostDest, `cat > ${this.dir(jobId)}/stdin.pipe`, { stdin: text + '\n' });
  }

  async killJob(jobId: string, hostDest: string): Promise<void> {
    const d = this.dir(jobId);
    await this.t.exec(hostDest, `kill $(cat ${d}/pid) 2>/dev/null; pkill -f "jobs/${jobId}/script.sh" 2>/dev/null; true`);
    this.store.updateJob(jobId, { state: 'killed', finishedAt: Date.now() });
    this.emit('state', this.store.getJob(jobId));
    this.detach(jobId);
  }
}

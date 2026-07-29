import type { Host, Job, JobAction, JobSource, JobState } from '../../server/types.js';
import type { HealthReport } from '../../server/health.js';
import type { OnboardStep } from '../../server/onboarding.js';

export type { Host, Job, JobAction, JobSource, JobState, HealthReport, OnboardStep };

export interface HostView { host: Host; health: (HealthReport & { checkedAt: number }) | null; runningJob: Job | null }
export interface StartJobsResult { started: Job[]; refused: { host: string; reason: string }[] }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  hosts: (): Promise<HostView[]> => fetch('/api/hosts').then(r => json(r)),

  startJobs: (hosts: string[], action: JobAction, source: JobSource): Promise<StartJobsResult> =>
    fetch('/api/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hosts, action, source }),
    }).then(r => json(r)),

  hostJobs: (name: string): Promise<Job[]> => fetch(`/api/hosts/${encodeURIComponent(name)}/jobs`).then(r => json(r)),

  jobLog: (id: string): Promise<string> => fetch(`/api/jobs/${id}/log`).then(r => r.text()),

  sendInput: (id: string, text: string): Promise<void> =>
    fetch(`/api/jobs/${id}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then(() => undefined),

  kill: (id: string): Promise<void> =>
    fetch(`/api/jobs/${id}/kill`, { method: 'POST' }).then(() => undefined),

  refreshHealth: (hosts?: string[]): Promise<Record<string, HealthReport>> =>
    fetch('/api/health/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hosts }),
    }).then(r => json(r)),

  onboard: async (
    payload: { host: string; username: string; password: string; name: string },
    onStep: (s: OnboardStep) => void,
  ): Promise<void> => {
    const res = await fetch('/api/hosts/onboard', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onStep(JSON.parse(line) as OnboardStep);
      }
    }
  },
};

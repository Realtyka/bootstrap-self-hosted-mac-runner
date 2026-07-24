export interface Host { name: string; sshDest: string; tags: string[] }
export type JobAction = 'bootstrap' | 'launchagent';
export type JobSource = 'github' | 'local';
export type JobState = 'starting' | 'running' | 'stalled' | 'passed' | 'failed' | 'killed';
export interface Job {
  id: string; host: string; action: JobAction; source: JobSource;
  state: JobState; startedAt: number; finishedAt: number | null; exitCode: number | null;
}

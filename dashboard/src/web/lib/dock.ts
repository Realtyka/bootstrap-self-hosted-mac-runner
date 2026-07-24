import type { Job, JobState } from './api';

const MAX_LINES = 5000;

export interface DockTab { jobId: string; host: string; action: string; state: JobState }
export interface DockState {
  tabs: DockTab[];
  active: string | null;
  buffers: Record<string, string[]>;
}
export type DockEvent =
  | { type: 'job-started'; job: Job }
  | { type: 'log'; jobId: string; line: string }
  | { type: 'state'; job: Job }
  | { type: 'select'; jobId: string }
  | { type: 'close'; jobId: string }
  | { type: 'hydrate'; jobId: string; lines: string[] };

export const emptyDock: DockState = { tabs: [], active: null, buffers: {} };

export function dockReducer(s: DockState, e: DockEvent): DockState {
  switch (e.type) {
    case 'job-started': {
      if (s.tabs.some(t => t.jobId === e.job.id)) return { ...s, active: e.job.id };
      const tab: DockTab = { jobId: e.job.id, host: e.job.host, action: e.job.action, state: e.job.state };
      return { ...s, tabs: [...s.tabs, tab], active: e.job.id, buffers: { ...s.buffers, [e.job.id]: s.buffers[e.job.id] ?? [] } };
    }
    case 'log': {
      if (!(e.jobId in s.buffers)) return s;
      const buf = [...s.buffers[e.jobId], e.line];
      if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
      return { ...s, buffers: { ...s.buffers, [e.jobId]: buf } };
    }
    case 'state': {
      const tabs = s.tabs.map(t => (t.jobId === e.job.id ? { ...t, state: e.job.state } : t));
      return { ...s, tabs };
    }
    case 'select':
      return s.tabs.some(t => t.jobId === e.jobId) ? { ...s, active: e.jobId } : s;
    case 'close': {
      const tabs = s.tabs.filter(t => t.jobId !== e.jobId);
      const buffers = { ...s.buffers };
      delete buffers[e.jobId];
      const active = s.active === e.jobId ? (tabs.at(-1)?.jobId ?? null) : s.active;
      return { tabs, active, buffers };
    }
    case 'hydrate': {
      if (!s.tabs.some(t => t.jobId === e.jobId)) return s;
      return { ...s, buffers: { ...s.buffers, [e.jobId]: e.lines.slice(-MAX_LINES) } };
    }
  }
}

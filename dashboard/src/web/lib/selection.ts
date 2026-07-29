import type { HostView } from './api';

export function toggle(sel: Set<string>, name: string): Set<string> {
  const next = new Set(sel);
  if (next.has(name)) next.delete(name); else next.add(name);
  return next;
}

export function selectAll(hosts: string[]): Set<string> {
  return new Set(hosts);
}

export function clear(): Set<string> {
  return new Set();
}

/** Hosts allowed to receive a job: selected, not running, not known-unreachable. */
export function eligible(views: HostView[], sel: Set<string>): string[] {
  return views
    .filter(v => sel.has(v.host.name))
    .filter(v => !v.runningJob)
    .filter(v => v.health === null || v.health.reachable)
    .map(v => v.host.name);
}

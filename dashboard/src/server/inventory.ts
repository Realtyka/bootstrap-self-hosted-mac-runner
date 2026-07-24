import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { Host } from './types.js';

const HostsFile = z.object({
  hosts: z.array(z.object({
    name: z.string().min(1),
    sshDest: z.string().min(1),
    tags: z.array(z.string()).default([]),
  })).default([]),
});

export function loadHosts(path: string): Host[] {
  if (!existsSync(path)) return [];
  return HostsFile.parse(parse(readFileSync(path, 'utf8'))).hosts;
}

export function saveHosts(path: string, hosts: Host[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify({ hosts }));
}

export function addHost(path: string, host: Host): Host[] {
  const hosts = loadHosts(path);
  if (hosts.some(h => h.name === host.name)) throw new Error(`duplicate host name: ${host.name}`);
  const next = [...hosts, host];
  saveHosts(path, next);
  return next;
}

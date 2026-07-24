import Fastify from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { loadHosts } from './inventory.js';
import { JobRefusedError } from './jobs.js';
import type { JobEngine } from './jobs.js';
import type { Store } from './store.js';
import type { HealthReport } from './health.js';
import type { OnboardStep } from './onboarding.js';
import type { Host, Job, JobAction, JobSource } from './types.js';

export interface ApiDeps {
  store: Store;
  hostsPath: string;
  engine: Pick<JobEngine, 'startJob' | 'sendInput' | 'killJob' | 'on'>;
  probe: (sshDest: string) => Promise<HealthReport>;
  presign: (() => Promise<string>) | null;
  onboard: (p: { host: string; username: string; password: string; name: string }, onStep: (s: OnboardStep) => void) => Promise<OnboardStep[]>;
  extraEnv: Record<string, string>;
}

interface SseClient { write: (event: string, data: unknown) => void }

export async function buildApi(deps: ApiDeps) {
  const app = Fastify({ logger: false });
  const clients = new Set<SseClient>();
  const broadcast = (event: string, data: unknown) => { for (const c of clients) c.write(event, data); };

  deps.engine.on('log', (e: unknown) => broadcast('log', e));
  deps.engine.on('state', (j: unknown) => broadcast('state', j));

  const hostByName = (name: string): Host | undefined => loadHosts(deps.hostsPath).find(h => h.name === name);

  app.get('/api/hosts', async () => {
    return loadHosts(deps.hostsPath).map(host => {
      const h = deps.store.latestHealth(host.name);
      const running = deps.store.runningJobs().find(j => j.host === host.name) ?? null;
      return { host, health: h ? { ...JSON.parse(h.report), checkedAt: h.at } : null, runningJob: running };
    });
  });

  app.post<{ Body: { hosts: string[]; action: JobAction; source: JobSource } }>('/api/jobs', async (req, reply) => {
    const { hosts, action, source } = req.body;
    let envVars: Record<string, string> = { ...deps.extraEnv };
    if (action === 'bootstrap' && deps.presign) {
      try { envVars = { ...envVars, XCODE_XIP_URL: await deps.presign() }; }
      catch (e) { return reply.code(502).send({ error: `S3 presign failed: ${String(e)}` }); }
    }
    const started: Job[] = [];
    const refused: { host: string; reason: string }[] = [];
    await Promise.all(hosts.map(async name => {
      const host = hostByName(name);
      if (!host) { refused.push({ host: name, reason: 'unknown host' }); return; }
      try { started.push(await deps.engine.startJob({ host, action, source, envVars })); }
      catch (e) {
        refused.push({ host: name, reason: e instanceof JobRefusedError ? e.message : `failed to start: ${String(e)}` });
      }
    }));
    return { started, refused };
  });

  app.get<{ Params: { name: string } }>('/api/hosts/:name/jobs', async req => deps.store.jobsForHost(req.params.name));

  app.get<{ Params: { id: string } }>('/api/jobs/:id/log', async (req, reply) => {
    const path = deps.store.logPath(req.params.id);
    reply.type('text/plain');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>('/api/jobs/:id/input', async (req, reply) => {
    const job = deps.store.getJob(req.params.id);
    const host = job && hostByName(job.host);
    if (!job || !host) return reply.code(404).send({ error: 'unknown job' });
    await deps.engine.sendInput(job.id, host.sshDest, req.body.text);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/kill', async (req, reply) => {
    const job = deps.store.getJob(req.params.id);
    const host = job && hostByName(job.host);
    if (!job || !host) return reply.code(404).send({ error: 'unknown job' });
    await deps.engine.killJob(job.id, host.sshDest);
    return { ok: true };
  });

  app.post<{ Body: { hosts?: string[] } }>('/api/health/refresh', async req => {
    const all = loadHosts(deps.hostsPath);
    const targets = req.body?.hosts?.length ? all.filter(h => req.body.hosts!.includes(h.name)) : all;
    const out: Record<string, HealthReport> = {};
    await Promise.all(targets.map(async h => {
      const report = await deps.probe(h.sshDest);
      out[h.name] = report;
      deps.store.saveHealth(h.name, JSON.stringify(report), report.checkedAt);
      broadcast('health', { host: h.name, report });
    }));
    return out;
  });

  app.post<{ Body: { host: string; username: string; password: string; name: string } }>('/api/hosts/onboard', async (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
    await deps.onboard(req.body, step => reply.raw.write(JSON.stringify(step) + '\n'));
    reply.raw.end();
    return reply;
  });

  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const client: SseClient = {
      write: (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    };
    clients.add(client);
    reply.raw.write(': connected\n\n');
    req.raw.on('close', () => clients.delete(client));
  });

  return app;
}

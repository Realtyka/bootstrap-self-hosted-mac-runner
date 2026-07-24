import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { loadHosts } from './inventory.js';
import { parsePins } from './pins.js';
import { SystemSshTransport } from './ssh.js';
import { Store } from './store.js';
import { JobEngine } from './jobs.js';
import { probeHost } from './health.js';
import { presignXipUrl } from './artifacts.js';
import { onboardHost, ssh2Connect } from './onboarding.js';
import { buildApi } from './api.js';

const cfg = loadConfig();
const transport = new SystemSshTransport();
const store = new Store(join(cfg.dataDir, 'fleet.db'), join(cfg.dataDir, 'logs'));

const scriptPath = join(cfg.repoRoot, 'bootstrap-macos-runner.sh');
const pins = parsePins(readFileSync(scriptPath, 'utf8'));

const engine = new JobEngine({ transport, store, repoRoot: cfg.repoRoot, rawBaseUrl: cfg.rawBaseUrl });

const pubKeyPath = join(process.env.HOME ?? '~', '.ssh', 'id_ed25519.pub');

const app = await buildApi({
  store,
  hostsPath: cfg.hostsPath,
  engine,
  probe: dest => probeHost(transport, dest, pins),
  presign: cfg.s3XipUri ? () => presignXipUrl({ s3Uri: cfg.s3XipUri!, region: cfg.awsRegion }) : null,
  onboard: (p, onStep) => {
    if (!existsSync(pubKeyPath)) throw new Error(`no public key at ${pubKeyPath} — run: ssh-keygen -t ed25519`);
    return onboardHost({
      ...p,
      pubKey: readFileSync(pubKeyPath, 'utf8'),
      connect: ssh2Connect,
      verifyTransport: transport,
      hostsPath: cfg.hostsPath,
      onStep,
    });
  },
  extraEnv: cfg.extraEnv,
});

// Serve built web UI when present
const webDist = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web');
if (existsSync(join(webDist, 'index.html'))) {
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root: webDist });
}

await engine.reattachAll(loadHosts(cfg.hostsPath));

async function probeAll() {
  for (const h of loadHosts(cfg.hostsPath)) {
    try {
      const report = await probeHost(transport, h.sshDest, pins);
      store.saveHealth(h.name, JSON.stringify(report), report.checkedAt);
    } catch { /* host probe failures are reflected as unreachable on next success */ }
  }
}
void probeAll();
setInterval(probeAll, cfg.probeIntervalMs);

await app.listen({ port: cfg.port, host: '127.0.0.1' });
console.log(`mac-fleet dashboard: http://127.0.0.1:${cfg.port}`);

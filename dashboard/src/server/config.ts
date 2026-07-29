import { resolve } from 'node:path';

export interface Config {
  port: number;
  hostsPath: string;
  dataDir: string;
  repoRoot: string;
  rawBaseUrl: string;
  s3XipUri: string | null;
  awsRegion: string;
  probeIntervalMs: number;
  extraEnv: Record<string, string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const extraEnv: Record<string, string> = {};
  if (env.XCODE_APPLE_ID) extraEnv.XCODE_APPLE_ID = env.XCODE_APPLE_ID;
  if (env.XCODE_APPLE_ID_PASSWORD) extraEnv.XCODE_APPLE_ID_PASSWORD = env.XCODE_APPLE_ID_PASSWORD;
  return {
    port: Number(env.PORT ?? 4400),
    hostsPath: resolve(env.HOSTS_PATH ?? 'hosts.yaml'),
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    repoRoot: resolve(env.REPO_ROOT ?? '..'),
    rawBaseUrl: env.RAW_BASE_URL ?? 'https://raw.githubusercontent.com/Realtyka/bootstrap-self-hosted-mac-runner/main',
    s3XipUri: env.S3_XIP_URI ?? null,
    awsRegion: env.AWS_REGION ?? 'us-east-1',
    probeIntervalMs: Number(env.PROBE_INTERVAL_MS ?? 300_000),
    extraEnv,
  };
}

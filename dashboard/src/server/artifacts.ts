import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const m = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`expected s3://bucket/key, got: ${uri}`);
  return { bucket: m[1], key: m[2] };
}

export async function presignXipUrl(cfg: { s3Uri: string; region: string; expiresSec?: number }): Promise<string> {
  const { bucket, key } = parseS3Uri(cfg.s3Uri);
  const client = new S3Client({ region: cfg.region });
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: cfg.expiresSec ?? 21600 });
}

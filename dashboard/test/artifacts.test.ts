import { describe, it, expect } from 'vitest';
import { presignXipUrl, parseS3Uri } from '../src/server/artifacts.js';

describe('parseS3Uri', () => {
  it('splits bucket and key', () => {
    expect(parseS3Uri('s3://my-bucket/path/Xcode_26.0.xip')).toEqual({ bucket: 'my-bucket', key: 'path/Xcode_26.0.xip' });
  });
  it('rejects non-s3 uris', () => {
    expect(() => parseS3Uri('https://x')).toThrow(/s3:\/\//);
  });
});

describe('presignXipUrl', () => {
  it('returns a signed https url for the object', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'testsecret';
    const url = await presignXipUrl({ s3Uri: 's3://my-fleet-bucket/Xcode_26.0.xip', region: 'us-east-1' });
    expect(url).toMatch(/^https:\/\/my-fleet-bucket\.s3\.us-east-1\.amazonaws\.com\/Xcode_26\.0\.xip\?/);
    expect(url).toContain('X-Amz-Expires=21600');
    expect(url).toContain('X-Amz-Signature=');
  });
});

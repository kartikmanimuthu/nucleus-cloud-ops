import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { parseContent, isSupportedKey, getMime } from '../lib/parsing.js';
import { chunkText } from '../lib/chunking.js';
import { embedAndStore } from '../lib/embedding.js';
import type { S3SyncJob } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const region = process.env.AWS_REGION || 'ap-south-1';
const MAX_FILES = 50;

// ---------------------------------------------------------------------------
// S3 sync handler
// ---------------------------------------------------------------------------

export async function handleS3Sync(job: S3SyncJob): Promise<string[]> {
  const srcS3 = new S3Client({ region: job.config.region || region });
  const list = await srcS3.send(new ListObjectsV2Command({ Bucket: job.config.bucketName, Prefix: job.config.prefix, MaxKeys: MAX_FILES }));
  let objects = (list.Contents || []).filter((o) => o.Key && isSupportedKey(o.Key));
  if (job.config.filePatterns?.length) {
    objects = objects.filter((o) => job.config.filePatterns!.some((p) => o.Key!.includes(p.replace(/\*/g, ''))));
  }
  const allKeys: string[] = [];
  for (const obj of objects.slice(0, MAX_FILES)) {
    try {
      const get = await srcS3.send(new GetObjectCommand({ Bucket: job.config.bucketName, Key: obj.Key! }));
      const chunks: Uint8Array[] = [];
      for await (const c of get.Body as AsyncIterable<Uint8Array>) chunks.push(c);
      const buf = Buffer.concat(chunks);
      const fileName = obj.Key!.split('/').pop() || obj.Key!;
      const text = await parseContent(buf, getMime(obj.Key!), fileName);
      const kbChunks = chunkText(text, fileName);
      const keys = await embedAndStore({ chunks: kbChunks, kbId: job.kbId, dsId: job.dsId, sourceType: 's3-bucket', docName: fileName, extra: { s3Key: obj.Key! } });
      allKeys.push(...keys);
    } catch (e) { console.error(`[KB Sync] S3 skip ${obj.Key}:`, e); }
  }
  return allKeys;
}

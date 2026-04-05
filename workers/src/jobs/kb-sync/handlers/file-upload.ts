import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { parseContent } from '../lib/parsing.js';
import { chunkText } from '../lib/chunking.js';
import { embedAndStore } from '../lib/embedding.js';
import type { FileUploadJob } from '../types.js';

// ---------------------------------------------------------------------------
// Clients & config
// ---------------------------------------------------------------------------

const region = process.env.AWS_REGION || 'ap-south-1';
const s3 = new S3Client({ region });
const STAGING_BUCKET = process.env.KB_STAGING_BUCKET_NAME!;

// ---------------------------------------------------------------------------
// File upload handler
// ---------------------------------------------------------------------------

export async function handleFileUpload(job: FileUploadJob): Promise<string[]> {
  const res = await s3.send(new GetObjectCommand({ Bucket: STAGING_BUCKET, Key: job.stagingKey }));
  const chunks: Uint8Array[] = [];
  for await (const c of res.Body as AsyncIterable<Uint8Array>) chunks.push(c);
  const buffer = Buffer.concat(chunks);
  const text = await parseContent(buffer, job.mimeType, job.fileName);
  const kbChunks = chunkText(text, job.fileName);
  return embedAndStore({ chunks: kbChunks, kbId: job.kbId, dsId: job.dsId, sourceType: 'file-upload', docName: job.fileName });
}

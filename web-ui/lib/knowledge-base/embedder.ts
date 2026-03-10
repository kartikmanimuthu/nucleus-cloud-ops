/**
 * Knowledge Base Embedder
 *
 * Text chunking, Bedrock embedding (Titan v2), and S3 Vectors store/delete
 * for the knowledge-base-embeddings index.
 *
 * Patterns adapted from:
 *   - web-ui/app/api/ask-ai/route.ts  (getEmbedding)
 *   - lambda/vector_processor/src/index.ts  (PutVectorsCommand batching)
 */

import { createHash } from 'crypto';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  S3VectorsClient,
  PutVectorsCommand,
  DeleteVectorsCommand,
} from '@aws-sdk/client-s3vectors';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { KBChunk, VectorMetadata } from './types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL_ID =
  process.env.BEDROCK_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const KB_VECTOR_BUCKET_NAME =
  process.env.KB_VECTOR_BUCKET_NAME || process.env.VECTOR_BUCKET_NAME || '';
const KB_VECTOR_INDEX_NAME =
  process.env.KB_VECTOR_INDEX_NAME || 'knowledge-base-embeddings';
const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const SEPARATORS = ['\n\n', '\n', '. ', ' '];
const EMBEDDING_CONCURRENCY = 5;
const VECTOR_BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// AWS Clients (lazy-initialised)
// ---------------------------------------------------------------------------

const credentialProvider = fromNodeProviderChain();

let _bedrockClient: BedrockRuntimeClient | null = null;
function getBedrockClient(): BedrockRuntimeClient {
  if (!_bedrockClient) {
    _bedrockClient = new BedrockRuntimeClient({
      region: AWS_REGION,
      credentials: credentialProvider,
    });
  }
  return _bedrockClient;
}

let _s3VectorsClient: S3VectorsClient | null = null;
function getS3VectorsClient(): S3VectorsClient {
  if (!_s3VectorsClient) {
    _s3VectorsClient = new S3VectorsClient({
      region: AWS_REGION,
      credentials: credentialProvider,
    });
  }
  return _s3VectorsClient;
}

// ---------------------------------------------------------------------------
// Text chunking (recursive character splitter)
// ---------------------------------------------------------------------------

/**
 * Split `text` into chunks of ~CHUNK_SIZE characters with CHUNK_OVERLAP overlap.
 * Each chunk is prefixed with "Document: {documentName} | Chunk {i}/{n}\n\n".
 */
export function chunkText(text: string, documentName: string): KBChunk[] {
  const rawChunks = recursiveSplit(text, CHUNK_SIZE, SEPARATORS);

  // Apply overlap — prepend tail of previous chunk to current chunk
  const overlapped: string[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    if (i === 0) {
      overlapped.push(rawChunks[i]);
    } else {
      const prevTail = rawChunks[i - 1].slice(-CHUNK_OVERLAP);
      overlapped.push(prevTail + rawChunks[i]);
    }
  }

  const total = overlapped.length;
  return overlapped.map((chunk, idx) => ({
    text: `Document: ${documentName} | Chunk ${idx + 1}/${total}\n\n${chunk}`,
    index: idx,
    total,
  }));
}

function recursiveSplit(text: string, maxLen: number, seps: string[]): string[] {
  if (text.length <= maxLen) return [text];

  for (const sep of seps) {
    const parts = text.split(sep).filter(Boolean);
    if (parts.length <= 1) continue;

    const chunks: string[] = [];
    let current = '';

    for (const part of parts) {
      const candidate = current ? current + sep + part : part;
      if (candidate.length > maxLen && current) {
        chunks.push(current);
        current = part;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);

    // Recursively split any chunks that are still too large
    const result: string[] = [];
    for (const chunk of chunks) {
      if (chunk.length > maxLen) {
        const remainingSeps = seps.slice(seps.indexOf(sep) + 1);
        result.push(
          ...(remainingSeps.length > 0
            ? recursiveSplit(chunk, maxLen, remainingSeps)
            : forceChunk(chunk, maxLen)),
        );
      } else {
        result.push(chunk);
      }
    }
    return result;
  }

  // Fallback: hard split
  return forceChunk(text, maxLen);
}

function forceChunk(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

/**
 * Generate a 1024-dim embedding via Bedrock Titan Embed Text v2.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const response = await getBedrockClient().send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL_ID,
      body: JSON.stringify({ inputText: text.slice(0, 8000) }),
      contentType: 'application/json',
      accept: 'application/json',
    }),
  );
  const bodyString = new TextDecoder().decode(response.body);
  return JSON.parse(bodyString).embedding;
}

// ---------------------------------------------------------------------------
// Content hash (SHA-256, for dedup)
// ---------------------------------------------------------------------------

export function computeContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Store chunks as vectors
// ---------------------------------------------------------------------------

/**
 * Embed all chunks and write them to the knowledge-base-embeddings S3 Vectors index.
 * Returns the vector keys that were written.
 */
export async function embedAndStoreChunks(params: {
  chunks: KBChunk[];
  knowledgeBaseId: string;
  dataSourceId: string;
  sourceType: string;
  documentName: string;
  extraMetadata?: Partial<VectorMetadata>;
}): Promise<string[]> {
  const { chunks, knowledgeBaseId, dataSourceId, sourceType, documentName, extraMetadata } =
    params;

  if (!KB_VECTOR_BUCKET_NAME) {
    throw new Error('KB_VECTOR_BUCKET_NAME (or VECTOR_BUCKET_NAME) is not configured');
  }

  // 1. Generate embeddings with concurrency limit
  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBEDDING_CONCURRENCY) {
    const batch = chunks.slice(i, i + EMBEDDING_CONCURRENCY);
    const batchEmbeddings = await Promise.all(
      batch.map((chunk) => getEmbedding(chunk.text)),
    );
    embeddings.push(...batchEmbeddings);
  }

  // 2. Build vector records
  const vectors = chunks.map((chunk, idx) => {
    const contentHash = computeContentHash(chunk.text);
    const key = `kb_${knowledgeBaseId}_${dataSourceId}_${chunk.index}_${contentHash}`;

    const metadata: Record<string, string> = {
      knowledgeBaseId,
      dataSourceId,
      sourceType,
      documentName,
      chunkIndex: String(chunk.index),
      totalChunks: String(chunk.total),
      contentHash,
      text_content: chunk.text.slice(0, 500),
      ...(extraMetadata?.s3Key && { s3Key: extraMetadata.s3Key }),
      ...(extraMetadata?.confluencePageId && {
        confluencePageId: extraMetadata.confluencePageId,
      }),
      ...(extraMetadata?.bitbucketRepo && { bitbucketRepo: extraMetadata.bitbucketRepo }),
      ...(extraMetadata?.bitbucketPath && { bitbucketPath: extraMetadata.bitbucketPath }),
    };

    return { key, data: { float32: embeddings[idx] }, metadata };
  });

  // 3. Write in batches of VECTOR_BATCH_SIZE
  const keys: string[] = [];
  for (let i = 0; i < vectors.length; i += VECTOR_BATCH_SIZE) {
    const batch = vectors.slice(i, i + VECTOR_BATCH_SIZE);
    await getS3VectorsClient().send(
      new PutVectorsCommand({
        vectorBucketName: KB_VECTOR_BUCKET_NAME,
        indexName: KB_VECTOR_INDEX_NAME,
        vectors: batch as any,
      }),
    );
    keys.push(...batch.map((v) => v.key));
  }

  console.log(
    `[KBEmbedder] Stored ${keys.length} vectors for "${documentName}" in ${KB_VECTOR_INDEX_NAME}`,
  );
  return keys;
}

// ---------------------------------------------------------------------------
// Delete vectors
// ---------------------------------------------------------------------------

/**
 * Delete vectors by their keys from the knowledge-base-embeddings index.
 */
export async function deleteVectors(vectorKeys: string[]): Promise<void> {
  if (!vectorKeys.length) return;

  if (!KB_VECTOR_BUCKET_NAME) {
    throw new Error('KB_VECTOR_BUCKET_NAME (or VECTOR_BUCKET_NAME) is not configured');
  }

  // Delete in batches of VECTOR_BATCH_SIZE
  for (let i = 0; i < vectorKeys.length; i += VECTOR_BATCH_SIZE) {
    const batch = vectorKeys.slice(i, i + VECTOR_BATCH_SIZE);
    await getS3VectorsClient().send(
      new DeleteVectorsCommand({
        vectorBucketName: KB_VECTOR_BUCKET_NAME,
        indexName: KB_VECTOR_INDEX_NAME,
        keys: batch,
      }),
    );
  }

  console.log(
    `[KBEmbedder] Deleted ${vectorKeys.length} vectors from ${KB_VECTOR_INDEX_NAME}`,
  );
}

// ---------------------------------------------------------------------------
// File content parsing
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a file buffer based on its MIME type.
 * Supports PDF (via pdf-parse), markdown, and plain text.
 */
export async function parseFileContent(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<string> {
  if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
    // Dynamic import to avoid bundling pdf-parse when not needed
    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(buffer);
    return result.text;
  }

  // Markdown, plain text, and other text-based formats
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    fileName.endsWith('.md') ||
    fileName.endsWith('.txt') ||
    fileName.endsWith('.csv') ||
    fileName.endsWith('.json') ||
    fileName.endsWith('.yaml') ||
    fileName.endsWith('.yml')
  ) {
    return buffer.toString('utf-8');
  }

  throw new Error(`Unsupported file type: ${mimeType} (${fileName})`);
}

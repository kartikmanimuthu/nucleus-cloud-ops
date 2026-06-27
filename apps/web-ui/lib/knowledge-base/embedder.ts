/**
 * Knowledge Base Embedder
 *
 * Text chunking, Bedrock embedding (Titan v2), and pgvector store/delete
 * for the kb_document_chunks table.
 */

import { createHash } from 'crypto';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getPrismaClient } from '@/lib/db/pg-config';
import type { KBChunk, VectorMetadata } from './types';
import { env } from '@/env';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL_ID =
  env.BEDROCK_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const AWS_REGION = env.AWS_REGION || 'ap-south-1';

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

// ---------------------------------------------------------------------------
// Text chunking (recursive character splitter)
// ---------------------------------------------------------------------------

/**
 * Split `text` into chunks of ~CHUNK_SIZE characters with CHUNK_OVERLAP overlap.
 * Each chunk is prefixed with "Document: {documentName} | Chunk {i}/{n}\n\n".
 *
 * `contentHash` is computed on the raw (un-prefixed) chunk so that the same
 * content always produces the same hash regardless of document name or position.
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
  return overlapped.map((rawChunk, idx) => ({
    contentHash: computeContentHash(rawChunk),
    text: `Document: ${documentName} | Chunk ${idx + 1}/${total}\n\n${rawChunk}`,
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
// Store chunks as vectors in PostgreSQL (pgvector)
// ---------------------------------------------------------------------------

/**
 * Embed all chunks and write them to the kb_document_chunks table via pgvector.
 * Returns the vector keys that were written.
 */
export async function embedAndStoreChunks(params: {
  chunks: KBChunk[];
  knowledgeBaseId: string;
  dataSourceId: string;
  sourceType: string;
  documentName: string;
  tenantId: string;
  extraMetadata?: Partial<VectorMetadata>;
}): Promise<string[]> {
  const { chunks, knowledgeBaseId, dataSourceId, sourceType, documentName, tenantId, extraMetadata } =
    params;

  const prisma = getPrismaClient();

  // 1. Generate embeddings with concurrency limit
  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBEDDING_CONCURRENCY) {
    const batch = chunks.slice(i, i + EMBEDDING_CONCURRENCY);
    const batchEmbeddings = await Promise.all(
      batch.map((chunk) => getEmbedding(chunk.text)),
    );
    embeddings.push(...batchEmbeddings);
  }

  // 2. Insert into kb_document_chunks with ON CONFLICT upsert
  const keys: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const contentHash = chunk.contentHash;
    const vectorKey = `kb_${knowledgeBaseId}_${dataSourceId}_${chunk.index}_${contentHash}`;
    const vectorLiteral = `[${embeddings[i].join(',')}]`;
    const metadata: Record<string, string> = {};
    if (extraMetadata?.s3Key) metadata.s3Key = extraMetadata.s3Key;
    if (extraMetadata?.confluencePageId) metadata.confluencePageId = extraMetadata.confluencePageId;
    if (extraMetadata?.bitbucketRepo) metadata.bitbucketRepo = extraMetadata.bitbucketRepo;
    if (extraMetadata?.bitbucketPath) metadata.bitbucketPath = extraMetadata.bitbucketPath;

    await prisma.$executeRawUnsafe(
      `INSERT INTO kb_document_chunks
         ("id", "tenantId", "knowledgeBaseId", "dataSourceId", "vectorKey",
          "documentName", "sourceType", "chunkIndex", "totalChunks",
          "contentHash", "textContent", "metadata", "embedding")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::vector)
       ON CONFLICT ("vectorKey") DO UPDATE SET
         "textContent" = EXCLUDED."textContent",
         "embedding" = EXCLUDED."embedding",
         "contentHash" = EXCLUDED."contentHash",
         "metadata" = EXCLUDED."metadata"`,
      tenantId, knowledgeBaseId, dataSourceId, vectorKey,
      documentName, sourceType, chunk.index, chunk.total,
      contentHash, chunk.text.slice(0, 2000), JSON.stringify(metadata), vectorLiteral,
    );
    keys.push(vectorKey);
  }

  console.log(
    `[KBEmbedder] Stored ${keys.length} vectors for "${documentName}" in kb_document_chunks`,
  );
  return keys;
}

// ---------------------------------------------------------------------------
// Delete vectors
// ---------------------------------------------------------------------------

/**
 * Delete vectors by their keys from the kb_document_chunks table.
 */
export async function deleteVectors(vectorKeys: string[]): Promise<void> {
  if (!vectorKeys.length) return;

  const prisma = getPrismaClient();

  // Delete in batches of VECTOR_BATCH_SIZE
  for (let i = 0; i < vectorKeys.length; i += VECTOR_BATCH_SIZE) {
    const batch = vectorKeys.slice(i, i + VECTOR_BATCH_SIZE);
    await prisma.$executeRawUnsafe(
      `DELETE FROM kb_document_chunks WHERE "vectorKey" = ANY($1::text[])`,
      batch,
    );
  }

  console.log(
    `[KBEmbedder] Deleted ${vectorKeys.length} vectors from kb_document_chunks`,
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

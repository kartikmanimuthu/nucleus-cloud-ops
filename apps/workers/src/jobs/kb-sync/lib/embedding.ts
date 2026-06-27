import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { Pool } from 'pg';
import type { Chunk } from './chunking.js';
import { env } from '../../../env.js';

// ---------------------------------------------------------------------------
// Clients & config
// ---------------------------------------------------------------------------

const region = env.AWS_REGION || 'ap-south-1';
const bedrock = new BedrockRuntimeClient({ region });
const BEDROCK_MODEL = env.BEDROCK_MODEL_ID || 'amazon.titan-embed-text-v2:0';

export const EMBEDDING_CONCURRENCY = 5;
export const VECTOR_BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// pg Pool (lazy init — same pattern as discovery/services/db.ts)
// ---------------------------------------------------------------------------

let _pool: Pool | null = null;
function getPool(): Pool {
  if (!_pool) {
    const DATABASE_URL = env.DATABASE_URL;
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required for kb-sync embedding');
    _pool = new Pool({
      connectionString: DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  return _pool;
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

export async function getEmbedding(text: string): Promise<number[]> {
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL,
    body: JSON.stringify({ inputText: text.slice(0, 8000) }),
    contentType: 'application/json',
    accept: 'application/json',
  }));
  return JSON.parse(new TextDecoder().decode(res.body)).embedding;
}

// ---------------------------------------------------------------------------
// Store chunks as vectors in PostgreSQL (pgvector)
// ---------------------------------------------------------------------------

export async function embedAndStore(params: {
  chunks: Chunk[];
  kbId: string;
  dsId: string;
  sourceType: string;
  docName: string;
  tenantId: string;
  docId?: string;
  extra?: Record<string, string>;
}): Promise<string[]> {
  const { chunks, kbId, dsId, sourceType, docName, tenantId, docId = '', extra = {} } = params;
  const keys: string[] = [];

  for (let i = 0; i < chunks.length; i += EMBEDDING_CONCURRENCY) {
    const batch = chunks.slice(i, i + EMBEDDING_CONCURRENCY);
    const embeddings = await Promise.all(batch.map((c) => getEmbedding(c.text)));

    const pool = getPool();
    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const vectorKey = `kb_${kbId}_${dsId}_${docId}_${chunk.index}_${chunk.contentHash}`;
      const vectorLiteral = `[${embeddings[j].join(',')}]`;
      const metadata = JSON.stringify(extra);

      await pool.query(
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
        [
          tenantId, kbId, dsId, vectorKey,
          docName, sourceType, chunk.index, chunk.total,
          chunk.contentHash, chunk.text.slice(0, 2000), metadata, vectorLiteral,
        ],
      );
      keys.push(vectorKey);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Delete vectors from PostgreSQL
// ---------------------------------------------------------------------------

export async function deleteOldVectors(keys: string[]): Promise<void> {
  if (!keys?.length) return;
  const pool = getPool();
  for (let i = 0; i < keys.length; i += 500) {
    const batch = keys.slice(i, i + 500);
    await pool.query(
      `DELETE FROM kb_document_chunks WHERE "vectorKey" = ANY($1::text[])`,
      [batch],
    );
  }
}

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3VectorsClient, PutVectorsCommand, DeleteVectorsCommand } from '@aws-sdk/client-s3vectors';
import type { Chunk } from './chunking.js';

// ---------------------------------------------------------------------------
// Clients & config
// ---------------------------------------------------------------------------

const region = process.env.AWS_REGION || 'ap-south-1';
const bedrock = new BedrockRuntimeClient({ region });
const s3vectors = new S3VectorsClient({ region });

const KB_VECTOR_BUCKET = process.env.KB_VECTOR_BUCKET_NAME!;
const KB_VECTOR_INDEX = process.env.KB_VECTOR_INDEX_NAME!;
const BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || 'amazon.titan-embed-text-v2:0';

export const EMBEDDING_CONCURRENCY = 5;
export const VECTOR_BATCH_SIZE = 20;

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

export async function embedAndStore(params: {
  chunks: Chunk[];
  kbId: string;
  dsId: string;
  sourceType: string;
  docName: string;
  docId?: string;
  extra?: Record<string, string>;
}): Promise<string[]> {
  const { chunks, kbId, dsId, sourceType, docName, docId = '', extra = {} } = params;
  const keys: string[] = [];

  for (let i = 0; i < chunks.length; i += EMBEDDING_CONCURRENCY) {
    const batch = chunks.slice(i, i + EMBEDDING_CONCURRENCY);
    const embeddings = await Promise.all(batch.map((c) => getEmbedding(c.text)));

    const vectors = batch.map((chunk, j) => ({
      key: `kb_${kbId}_${dsId}_${docId}_${chunk.index}_${chunk.contentHash}`,
      data: { float32: embeddings[j] },
      metadata: {
        knowledgeBaseId: kbId,
        dataSourceId: dsId,
        sourceType,
        documentName: docName,
        chunkIndex: String(chunk.index),
        totalChunks: String(chunk.total),
        contentHash: chunk.contentHash,
        text_content: chunk.text.slice(0, 500),
        ...extra,
      },
    }));

    for (let b = 0; b < vectors.length; b += VECTOR_BATCH_SIZE) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s3vectors.send(new PutVectorsCommand({ vectorBucketName: KB_VECTOR_BUCKET, indexName: KB_VECTOR_INDEX, vectors: vectors.slice(b, b + VECTOR_BATCH_SIZE) as any }));
    }
    keys.push(...vectors.map((v) => v.key));
  }
  return keys;
}

export async function deleteOldVectors(keys: string[]): Promise<void> {
  if (!keys?.length) return;
  for (let i = 0; i < keys.length; i += 500) {
    await s3vectors.send(new DeleteVectorsCommand({
      vectorBucketName: KB_VECTOR_BUCKET,
      indexName: KB_VECTOR_INDEX,
      keys: keys.slice(i, i + 500),
    }));
  }
}

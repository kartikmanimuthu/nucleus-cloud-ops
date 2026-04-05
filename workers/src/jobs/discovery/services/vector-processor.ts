// workers/src/jobs/discovery/services/vector-processor.ts
import { createHash } from 'crypto';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3VectorsClient, PutVectorsCommand, DeleteVectorsCommand } from '@aws-sdk/client-s3vectors';
import { PrismaClient } from '@prisma/client';
import type { Resource } from '../types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBEDDING_CONCURRENCY = 5;
const VECTOR_BATCH_SIZE = 20;
const DELETE_BATCH_SIZE = 500;

const region = process.env.AWS_REGION || 'ap-south-1';
const VECTOR_BUCKET_NAME = process.env.VECTOR_BUCKET_NAME!;
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_NAME!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'amazon.titan-embed-text-v2:0';
// USE_PG_INVENTORY is read at call time (not module load) so tests can override via process.env
const getUsePgInventory = (): boolean => process.env.USE_PG_INVENTORY === 'true';

// ---------------------------------------------------------------------------
// Lazy clients
// ---------------------------------------------------------------------------

let _bedrock: BedrockRuntimeClient | null = null;
function getBedrock(): BedrockRuntimeClient {
  if (!_bedrock) _bedrock = new BedrockRuntimeClient({ region });
  return _bedrock;
}

let _s3vectors: S3VectorsClient | null = null;
function getS3Vectors(): S3VectorsClient {
  if (!_s3vectors) _s3vectors = new S3VectorsClient({ region });
  return _s3vectors;
}

let _prisma: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ['warn', 'error'],
    });
  }
  return _prisma;
}

// ---------------------------------------------------------------------------
// Text + hash helpers (exported for testing)
// ---------------------------------------------------------------------------

export function createResourceText(resource: Resource): string {
  const parts: string[] = [];

  const name = resource.name || resource.resourceId || 'Unknown';
  parts.push(`Name: ${name}`);
  parts.push(`Type: ${resource.resourceType || 'Unknown'}`);
  parts.push(`Service: ${resource.service || resource.resourceType?.split('_')[0] || 'Unknown'}`);
  parts.push(`Region: ${resource.region || 'Unknown'}`);
  if (resource.state) {
    parts.push(`State: ${resource.state}`);
  }

  if (resource.resourceArn) {
    parts.push(`ARN: ${resource.resourceArn}`);
  }

  const tags = resource.tags;
  if (tags && typeof tags === 'object' && Object.keys(tags).length > 0) {
    const tagList = Object.entries(tags)
      .slice(0, 20)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    parts.push(`Tags: ${tagList}`);
  }

  // VPC-specific: surface CIDR block for semantic search
  if (resource.resourceType === 'ec2_vpcs' && resource.rawData && typeof resource.rawData === 'object') {
    const raw = resource.rawData as Record<string, unknown>;
    if (raw.CidrBlock) parts.push(`CIDR: ${raw.CidrBlock}`);
    if (raw.IsDefault) parts.push(`Default VPC: ${raw.IsDefault}`);
  }

  const meta = resource.rawData;
  if (meta && typeof meta === 'object') {
    const metaList: string[] = [];
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        metaList.push(`${k}=${v}`);
      } else if (Array.isArray(v) && v.length > 0 && v.length < 5) {
        metaList.push(`${k}=${v.join(',')}`);
      }
    }
    if (metaList.length > 0) {
      parts.push(`Details: ${metaList.join(', ')}`);
    }
  }

  return parts.join(' | ');
}

export function computeContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Embedding helper
// ---------------------------------------------------------------------------

async function getEmbedding(text: string): Promise<number[]> {
  const res = await getBedrock().send(
    new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      body: JSON.stringify({ inputText: text.slice(0, 8000) }),
      contentType: 'application/json',
      accept: 'application/json',
    }),
  );
  return JSON.parse(new TextDecoder().decode(res.body)).embedding;
}

// ---------------------------------------------------------------------------
// PG key tracking helpers
// ---------------------------------------------------------------------------

async function getPreviousVectorKeys(accountId: string): Promise<string[]> {
  try {
    const record = await getPrisma().inventoryVectorKey.findUnique({
      where: { accountId },
      select: { vectorKeys: true },
    });
    return record?.vectorKeys || [];
  } catch (err) {
    console.warn(`[vector-processor] Could not read previous keys for ${accountId}:`, err);
    return [];
  }
}

async function saveVectorKeys(accountId: string, keys: string[]): Promise<void> {
  await getPrisma().inventoryVectorKey.upsert({
    where: { accountId },
    update: { vectorKeys: keys },
    create: { accountId, vectorKeys: keys },
  });
}

// ---------------------------------------------------------------------------
// Stale vector cleanup
// ---------------------------------------------------------------------------

async function deleteStaleVectors(staleKeys: string[]): Promise<void> {
  if (!staleKeys.length) return;
  console.log(`[vector-processor] Deleting ${staleKeys.length} stale vectors`);
  for (let i = 0; i < staleKeys.length; i += DELETE_BATCH_SIZE) {
    await getS3Vectors().send(
      new DeleteVectorsCommand({
        vectorBucketName: VECTOR_BUCKET_NAME,
        indexName: VECTOR_INDEX_NAME,
        keys: staleKeys.slice(i, i + DELETE_BATCH_SIZE),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function processAccountVectors(
  resources: Resource[],
  accountId: string,
  tenantId: string,
): Promise<number> {
  if (!resources.length) return 0;

  // Deduplicate input resources by resourceId before embedding
  const seenIds = new Set<string>();
  const uniqueResources = resources.filter((r) => {
    if (!r.resourceId || seenIds.has(r.resourceId)) return false;
    seenIds.add(r.resourceId);
    return true;
  });

  // Fetch previous keys before processing (for stale cleanup)
  const previousKeys = getUsePgInventory() ? await getPreviousVectorKeys(accountId) : [];

  const vectorPayload: Array<{
    key: string;
    data: { float32: number[] };
    metadata: Record<string, string>;
  }> = [];

  // Embed in batches of EMBEDDING_CONCURRENCY to respect Bedrock rate limits
  for (let i = 0; i < uniqueResources.length; i += EMBEDDING_CONCURRENCY) {
    const batch = uniqueResources.slice(i, i + EMBEDDING_CONCURRENCY);

    const results = await Promise.all(
      batch.map(async (resource) => {
        if (!resource.resourceId) return null;

        const text = createResourceText(resource);
        if (!text) return null;

        const contentHash = computeContentHash(text);

        try {
          const embedding = await getEmbedding(text);
          return {
            key: `${resource.resourceId}_${contentHash}`,
            data: { float32: embedding },
            metadata: {
              resourceId: resource.resourceId,
              resourceArn: resource.resourceArn || '',
              resourceType: resource.resourceType || '',
              name: resource.name || resource.resourceId,
              region: resource.region || '',
              accountId,
              tenantId,
              state: resource.state || '',
              service: resource.service || '',
              contentHash,
              text_content: text.slice(0, 1000),
              lastDiscoveredAt: new Date().toISOString(),
            },
          };
        } catch (err) {
          console.error(`[vector-processor] Failed embedding for ${resource.resourceId}:`, err);
          return null;
        }
      }),
    );

    vectorPayload.push(...(results.filter(Boolean) as typeof vectorPayload));
  }

  if (!vectorPayload.length) {
    console.warn(`[vector-processor] No vectors generated for account ${accountId}`);
    return 0;
  }

  // Deduplicate by key
  const seen = new Set<string>();
  const deduped = vectorPayload.filter((v) => {
    if (seen.has(v.key)) return false;
    seen.add(v.key);
    return true;
  });

  if (deduped.length < vectorPayload.length) {
    console.warn(
      `[vector-processor] Deduplicated ${vectorPayload.length - deduped.length} duplicate keys for ${accountId}`,
    );
  }

  // Upsert to S3 Vectors in batches of VECTOR_BATCH_SIZE
  for (let i = 0; i < deduped.length; i += VECTOR_BATCH_SIZE) {
    const batch = deduped.slice(i, i + VECTOR_BATCH_SIZE);
    await getS3Vectors().send(
      new PutVectorsCommand({
        vectorBucketName: VECTOR_BUCKET_NAME,
        indexName: VECTOR_INDEX_NAME,
        // S3 Vectors SDK types don't accept our well-typed payload directly — cast required
        vectors: batch as any,
      }),
    );
  }

  const newKeys = deduped.map((v) => v.key);

  // Delete stale vectors and persist new keys (only when USE_PG_INVENTORY=true)
  if (getUsePgInventory()) {
    const newKeySet = new Set(newKeys);
    const staleKeys = previousKeys.filter((k) => !newKeySet.has(k));
    await deleteStaleVectors(staleKeys);
    await saveVectorKeys(accountId, newKeys);
  }

  console.log(`[vector-processor] Ingested ${deduped.length} vectors for account ${accountId}`);
  return deduped.length;
}

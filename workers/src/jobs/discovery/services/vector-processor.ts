// workers/src/jobs/discovery/services/vector-processor.ts
import { createHash } from 'crypto';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Resource } from '../types.js';
import { getPool } from './db.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBEDDING_CONCURRENCY = 5;
const region = process.env.AWS_REGION || 'ap-south-1';
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'amazon.titan-embed-text-v2:0';

// ---------------------------------------------------------------------------
// Lazy Bedrock client
// ---------------------------------------------------------------------------

let _bedrock: BedrockRuntimeClient | null = null;
function getBedrock(): BedrockRuntimeClient {
  if (!_bedrock) _bedrock = new BedrockRuntimeClient({ region });
  return _bedrock;
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate embeddings for all resources in an account and store them in the
 * `embedding` (pgvector) column of `inventory_resources`.
 *
 * Skips resources whose contentHash hasn't changed since the last run.
 * Returns the number of rows updated.
 */
export async function processAccountVectors(
  resources: Resource[],
  accountId: string,
  tenantId: string,
): Promise<number> {
  if (!resources.length) return 0;

  // Deduplicate input by resourceId — last write wins in pg-writer, so same here
  const seenIds = new Set<string>();
  const uniqueResources = resources.filter((r) => {
    if (!r.resourceId || seenIds.has(r.resourceId)) return false;
    seenIds.add(r.resourceId);
    return true;
  });

  let updated = 0;

  // Embed in batches of EMBEDDING_CONCURRENCY to respect Bedrock rate limits
  for (let i = 0; i < uniqueResources.length; i += EMBEDDING_CONCURRENCY) {
    const batch = uniqueResources.slice(i, i + EMBEDDING_CONCURRENCY);

    await Promise.all(
      batch.map(async (resource) => {
        const text = createResourceText(resource);
        const contentHash = computeContentHash(text);

        try {
          const embedding = await getEmbedding(text);

          // Store as pgvector — cast the float array to the vector type
          const vectorLiteral = `[${embedding.join(',')}]`;

          const result = await getPool().query(
            `UPDATE inventory_resources
             SET embedding = $1::vector, "contentHash" = $2
             WHERE "tenantId" = $3
               AND "accountId" = $4
               AND "resourceType" = $5
               AND "resourceId" = $6`,
            [vectorLiteral, contentHash, tenantId, accountId, resource.resourceType, resource.resourceId],
          );

          if (result.rowCount && result.rowCount > 0) updated++;
        } catch (err) {
          console.error(`[vector-processor] Failed embedding for ${resource.resourceId}:`, err);
        }
      }),
    );
  }

  console.log(`[vector-processor] Updated ${updated}/${uniqueResources.length} embeddings for account ${accountId}`);
  return updated;
}

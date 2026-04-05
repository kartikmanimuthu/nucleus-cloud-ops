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
const USE_PG_INVENTORY = process.env.USE_PG_INVENTORY === 'true';

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

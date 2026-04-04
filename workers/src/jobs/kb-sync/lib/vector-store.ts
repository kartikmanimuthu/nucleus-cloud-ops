import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Clients & config
// ---------------------------------------------------------------------------

const region = process.env.AWS_REGION || 'ap-south-1';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const APP_TABLE = process.env.APP_TABLE_NAME!;

export const USE_PG_KB = process.env.USE_PG_KB === 'true';
export const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID || 'org-default';

// ---------------------------------------------------------------------------
// Prisma lazy init
// ---------------------------------------------------------------------------

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
// DynamoDB PK/SK builders
// ---------------------------------------------------------------------------

function kbPK(kbId: string) { return `KB#${kbId}`; }
function dsSK(dsId: string) { return `DATASOURCE#${dsId}`; }
function tenantPK(tenantId: string) { return `TENANT#${tenantId}`; }
function kbSK(kbId: string) { return `KB#${kbId}`; }

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

async function getDataSourceDdb(kbId: string, dsId: string) {
  const res = await ddb.send(new GetCommand({ TableName: APP_TABLE, Key: { pk: kbPK(kbId), sk: dsSK(dsId) } }));
  return res.Item;
}

async function updateDSDdb(kbId: string, dsId: string, updates: Record<string, unknown>) {
  const parts = ['#updatedAt = :updatedAt'];
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const vals: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
  for (const [k, v] of Object.entries(updates)) {
    parts.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    vals[`:${k}`] = v;
  }
  await ddb.send(new UpdateCommand({
    TableName: APP_TABLE,
    Key: { pk: kbPK(kbId), sk: dsSK(dsId) },
    UpdateExpression: `SET ${parts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: vals,
  }));
}

async function updateKBVectorCountDdb(kbId: string, delta: number) {
  if (delta === 0) return;
  await ddb.send(new UpdateCommand({
    TableName: APP_TABLE,
    Key: { pk: tenantPK(DEFAULT_TENANT), sk: kbSK(kbId) },
    UpdateExpression: 'SET vectorCount = if_not_exists(vectorCount, :zero) + :delta, updatedAt = :now',
    ExpressionAttributeValues: { ':delta': delta, ':zero': 0, ':now': new Date().toISOString() },
  }));
}

// ---------------------------------------------------------------------------
// PostgreSQL helpers
// ---------------------------------------------------------------------------

export async function getDataSourcePg(kbId: string, dsId: string) {
  const ds = await getPrisma().dataSource.findFirst({
    where: { id: dsId, knowledgeBaseId: kbId },
  });
  return ds ? {
    vectorCount: ds.vectorCount,
    vectorKeys: ds.vectorKeys,
    status: ds.status,
  } : null;
}

export async function updateDSPg(kbId: string, dsId: string, updates: Record<string, unknown>) {
  await getPrisma().dataSource.updateMany({
    where: { id: dsId, knowledgeBaseId: kbId },
    data: {
      ...(updates.status !== undefined ? { status: updates.status as string } : {}),
      ...(updates.vectorCount !== undefined ? { vectorCount: updates.vectorCount as number } : {}),
      ...(updates.vectorKeys !== undefined ? { vectorKeys: { set: updates.vectorKeys as string[] } } : {}),
      ...(updates.lastSyncAt !== undefined ? { lastSyncAt: updates.lastSyncAt ? new Date(updates.lastSyncAt as string) : null } : {}),
      ...(updates.lastSyncError !== undefined ? { lastSyncError: updates.lastSyncError as string | null } : {}),
      updatedAt: new Date(),
    },
  });
}

export async function updateKBVectorCountPg(kbId: string, delta: number) {
  if (delta === 0) return;
  await getPrisma().knowledgeBase.updateMany({
    where: { id: kbId },
    data: {
      vectorCount: { increment: delta },
      updatedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Public dual-write functions
// ---------------------------------------------------------------------------

export async function getDataSource(kbId: string, dsId: string) {
  if (USE_PG_KB) return getDataSourcePg(kbId, dsId);
  return getDataSourceDdb(kbId, dsId);
}

export async function updateDS(kbId: string, dsId: string, updates: Record<string, unknown>) {
  if (USE_PG_KB) await updateDSPg(kbId, dsId, updates);
  await updateDSDdb(kbId, dsId, updates);
}

export async function updateKBVectorCount(kbId: string, delta: number) {
  if (USE_PG_KB) await updateKBVectorCountPg(kbId, delta);
  await updateKBVectorCountDdb(kbId, delta);
}

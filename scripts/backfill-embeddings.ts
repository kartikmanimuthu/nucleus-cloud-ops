#!/usr/bin/env npx tsx
/**
 * backfill-embeddings.ts
 *
 * Reads all inventory_resources rows with NULL embedding, generates Bedrock
 * Titan v2 embeddings, and writes them back to the embedding + contentHash columns.
 *
 * ⚠️  PROVIDER MODEL CAVEAT (2026-06): the app now resolves embeddings from each
 *     tenant's CONFIGURED provider (see lib/agent/embeddings-factory.ts), not a
 *     hardcoded Bedrock Titan client. This script still embeds with Titan v2 via
 *     host/task-role AWS creds. That is currently safe only because nothing
 *     queries `inventory_resources.embedding` at runtime (the Ask-AI path is
 *     text-to-SQL, not vector search; live vector search is kb_document_chunks +
 *     agent_memories). If inventory vector search is ever re-enabled, this script
 *     MUST be switched to the tenant's configured embedding model, or its vectors
 *     will live in a different embedding space than query-time vectors and rank
 *     garbage. Do NOT use this script to populate kb_document_chunks/agent_memories.
 *
 * Prerequisites:
 *   - docker compose up -d postgres (or DATABASE_URL pointing to your DB)
 *   - AWS credentials with bedrock:InvokeModel permission
 *
 * Usage:
 *   DATABASE_URL=postgresql://nucleus:nucleus_dev@localhost:5432/nucleus \
 *   AWS_PROFILE=PLATFORM-ADMIN AWS_REGION=ap-south-1 \
 *     npx tsx scripts/backfill-embeddings.ts
 *
 * Options (env vars):
 *   BATCH_SIZE=100        rows fetched per DB page (default: 100)
 *   CONCURRENCY=5         parallel Bedrock calls per batch (default: 5)
 *   DRY_RUN=true          skip Bedrock + DB writes, just count rows
 *   TENANT_ID=default     only backfill this tenant (default: all tenants)
 */

import { PrismaClient } from '@prisma/client';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { createHash } from 'crypto';

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const AWS_REGION = process.env.AWS_REGION ?? 'ap-south-1';
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'amazon.titan-embed-text-v2:0';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? '100', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '5', 10);
const DRY_RUN = process.env.DRY_RUN === 'true';
const TENANT_ID = process.env.TENANT_ID; // optional filter

if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is required');
    process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────

const prisma = new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
    log: ['warn', 'error'],
});

const bedrock = new BedrockRuntimeClient({ region: AWS_REGION });

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeContentHash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Build the same text representation used by the vector processor Lambda */
function createResourceText(row: {
    resourceId: string;
    resourceType: string;
    name: string | null;
    status: string | null;
    region: string;
    accountId: string;
    tags: unknown;
    metadata: unknown;
}): string {
    const parts: string[] = [];

    const name = row.name || row.resourceId || 'Unknown';
    parts.push(`Name: ${name}`);
    parts.push(`Type: ${row.resourceType || 'Unknown'}`);
    parts.push(`Service: ${row.resourceType?.split('_')[0] || 'Unknown'}`);
    parts.push(`Region: ${row.region || 'Unknown'}`);
    parts.push(`Account: ${row.accountId || 'Unknown'}`);

    if (row.status && row.status !== 'unknown') {
        parts.push(`State: ${row.status}`);
    }

    const tags = row.tags as Record<string, string> | null;
    if (tags && typeof tags === 'object' && Object.keys(tags).length > 0) {
        const tagList = Object.entries(tags)
            .slice(0, 20)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ');
        parts.push(`Tags: ${tagList}`);
    }

    const meta = row.metadata as Record<string, unknown> | null;
    if (meta && typeof meta === 'object') {
        // VPC-specific: surface CIDR prominently
        if (row.resourceType === 'ec2_vpcs') {
            if (meta.cidrBlock) parts.push(`CIDR: ${meta.cidrBlock}`);
            if (meta.isDefault) parts.push(`Default VPC: true`);
        }

        const metaList: string[] = [];
        for (const [k, v] of Object.entries(meta)) {
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

async function getEmbedding(text: string): Promise<number[]> {
    const response = await bedrock.send(
        new InvokeModelCommand({
            modelId: BEDROCK_MODEL_ID,
            body: JSON.stringify({ inputText: text.slice(0, 8000) }),
            contentType: 'application/json',
            accept: 'application/json',
        })
    );
    const body = JSON.parse(new TextDecoder().decode(response.body));
    return body.embedding as number[];
}

/** Process rows in chunks of CONCURRENCY, returning success/skip/fail counts */
async function processBatch(rows: Array<{
    id: string;
    resourceId: string;
    resourceType: string;
    name: string | null;
    status: string | null;
    region: string;
    accountId: string;
    tags: unknown;
    metadata: unknown;
}>): Promise<{ ok: number; skipped: number; failed: number }> {
    let ok = 0, skipped = 0, failed = 0;

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
        const chunk = rows.slice(i, i + CONCURRENCY);

        await Promise.all(chunk.map(async (row) => {
            try {
                const text = createResourceText(row);
                if (!text) { skipped++; return; }

                const contentHash = computeContentHash(text);

                if (DRY_RUN) { ok++; return; }

                const embedding = await getEmbedding(text);
                const vectorLiteral = `[${embedding.join(',')}]`;

                await prisma.$executeRawUnsafe(
                    `UPDATE inventory_resources
                     SET embedding = $1::vector, "contentHash" = $2
                     WHERE id = $3`,
                    vectorLiteral,
                    contentHash,
                    row.id
                );
                ok++;
            } catch (err) {
                console.error(`  ERROR on ${row.resourceId}:`, err instanceof Error ? err.message : err);
                failed++;
            }
        }));
    }

    return { ok, skipped, failed };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('='.repeat(60));
    console.log('Inventory Embedding Backfill');
    console.log('='.repeat(60));
    console.log(`Mode:        ${DRY_RUN ? 'DRY RUN (no Bedrock calls, no DB writes)' : 'LIVE'}`);
    console.log(`Model:       ${BEDROCK_MODEL_ID}`);
    console.log(`Batch size:  ${BATCH_SIZE}`);
    console.log(`Concurrency: ${CONCURRENCY}`);
    if (TENANT_ID) console.log(`Tenant:      ${TENANT_ID}`);
    console.log();

    // Count rows needing backfill
    const totalCount = await prisma.$queryRawUnsafe<[{ count: string }]>(
        `SELECT COUNT(*)::text AS count FROM inventory_resources
         WHERE embedding IS NULL${TENANT_ID ? ` AND "tenantId" = '${TENANT_ID}'` : ''}`
    );
    const total = parseInt(totalCount[0].count, 10);

    if (total === 0) {
        console.log('All rows already have embeddings. Nothing to do.');
        return;
    }

    console.log(`Rows needing embeddings: ${total}`);
    console.log('-'.repeat(40));

    let processed = 0;
    let totalOk = 0, totalSkipped = 0, totalFailed = 0;
    let lastId = '';
    const startTime = Date.now();

    // Use cursor-based pagination (keyset) — offset breaks when rows leave the
    // WHERE embedding IS NULL set as we update them mid-run.
    while (true) {
        const rows = await prisma.$queryRawUnsafe<Array<{
            id: string;
            resourceId: string;
            resourceType: string;
            name: string | null;
            status: string | null;
            region: string;
            accountId: string;
            tags: unknown;
            metadata: unknown;
        }>>(
            `SELECT id, "resourceId", "resourceType", name, status, region, "accountId", tags, metadata
             FROM inventory_resources
             WHERE embedding IS NULL
               ${TENANT_ID ? `AND "tenantId" = '${TENANT_ID}'` : ''}
               ${lastId ? `AND id > '${lastId}'` : ''}
             ORDER BY id
             LIMIT $1`,
            BATCH_SIZE
        );

        if (rows.length === 0) break;
        lastId = rows[rows.length - 1].id;

        const { ok, skipped, failed } = await processBatch(rows);
        totalOk += ok;
        totalSkipped += skipped;
        totalFailed += failed;
        processed += rows.length;

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = processed > 0 ? (processed / parseFloat(elapsed)).toFixed(1) : '?';
        console.log(`Progress: ${processed}/${total} (${Math.round(processed / total * 100)}%) — ${ok} ok, ${skipped} skipped, ${failed} failed — ${rate} rows/s`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log();
    console.log('='.repeat(60));
    console.log(`Done in ${elapsed}s`);
    console.log(`  Embedded:  ${totalOk}`);
    console.log(`  Skipped:   ${totalSkipped}`);
    console.log(`  Failed:    ${totalFailed}`);
    if (DRY_RUN) console.log('\n[DRY RUN] No changes written. Remove DRY_RUN=true to apply.');
}

main()
    .catch((err) => { console.error('FATAL:', err); process.exit(1); })
    .finally(() => prisma.$disconnect());

#!/usr/bin/env npx tsx
/**
 * migrate-rbac.ts
 *
 * Migrates all user-tenant-role records from DynamoDB UsersTeamsTable
 * to PostgreSQL user_tenant_roles table.
 *
 * Prerequisites:
 *   - docker compose up -d postgres (PostgreSQL running locally)
 *   - npm run db:migrate (schema applied, run from web-ui/)
 *   - DATABASE_URL set in environment
 *   - AWS credentials available (AWS_PROFILE=PLATFORM-ADMIN or env vars)
 *
 * Usage:
 *   AWS_PROFILE=PLATFORM-ADMIN DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nucleus npx tsx scripts/migrate-rbac.ts
 *
 *   Optionally override table name:
 *   DYNAMODB_USERS_TEAMS_TABLE=my-table DATABASE_URL=... npx tsx scripts/migrate-rbac.ts
 *
 * Idempotent: safe to re-run — uses upsert (ON CONFLICT DO UPDATE via Prisma upsert).
 * Progress: prints "Migrated X/Y records..." after each upsert.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { PrismaClient } from '@prisma/client';

// ── Configuration ─────────────────────────────────────────────────────────────

// UsersTeamsTable name — has a sensible default so it's optional in env vars
const USERS_TEAMS_TABLE = process.env.DYNAMODB_USERS_TEAMS_TABLE ?? 'nucleus-app-web-ui-users-teams';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────

// Credentials resolved via default provider chain (respects AWS_PROFILE env var)
const dynamoClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
        region: process.env.AWS_REGION ?? 'us-east-1',
    })
);

const prisma = new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
    log: ['error'],
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface DynamoRbacItem {
    PK?: string;
    SK?: string;
    EntityType?: string;
    userId?: string;
    tenantId?: string;
    email?: string;
    role?: string;
    assignedAt?: string;
    assignedBy?: string;
}

// ── Valid roles (matches CHECK constraint in migration SQL) ───────────────────

const VALID_ROLES = ['SuperAdmin', 'TenantAdmin', 'TenantOperator', 'TenantViewer'] as const;
type ValidRole = typeof VALID_ROLES[number];

function isValidRole(role: string | undefined): role is ValidRole {
    return VALID_ROLES.includes(role as ValidRole);
}

// ── DynamoDB Scan (full table scan filtered by EntityType=UserTenantRole) ─────

async function scanAllRbacItems(): Promise<DynamoRbacItem[]> {
    const items: DynamoRbacItem[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const command = new ScanCommand({
            TableName: USERS_TEAMS_TABLE,
            FilterExpression: 'EntityType = :entityType',
            ExpressionAttributeValues: {
                ':entityType': 'UserTenantRole',
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });

        const response = await dynamoClient.send(command);
        items.push(...((response.Items ?? []) as DynamoRbacItem[]));
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;

        if (lastEvaluatedKey) {
            console.log(`  Scanned ${items.length} records so far, fetching next page...`);
        }
    } while (lastEvaluatedKey);

    return items;
}

// ── Migration Logic ───────────────────────────────────────────────────────────

async function migrate(): Promise<void> {
    console.log('Starting RBAC migration: DynamoDB -> PostgreSQL');
    console.log(`  Source table: ${USERS_TEAMS_TABLE} (EntityType=UserTenantRole)`);
    console.log(`  AWS_PROFILE: ${process.env.AWS_PROFILE ?? '(default)'}`);
    console.log('');

    // Step 1: Scan all UserTenantRole records from DynamoDB
    console.log('Scanning DynamoDB for UserTenantRole records...');
    const items = await scanAllRbacItems();
    const total = items.length;
    console.log(`Found ${total} RBAC records to migrate.\n`);

    if (total === 0) {
        console.log('No records to migrate. Exiting.');
        return;
    }

    // Step 2: Upsert each record into PostgreSQL
    let count = 0;
    let skipped = 0;

    for (const item of items) {
        const userId = item.userId ?? item.PK?.replace('USER#', '');
        const tenantId = item.tenantId ?? item.SK?.replace('TENANT#', '');

        if (!userId || !tenantId) {
            console.warn(`  SKIP: malformed item with no userId/tenantId — PK=${item.PK}, SK=${item.SK}`);
            skipped++;
            continue;
        }

        // Validate role value against CHECK constraint values
        if (!isValidRole(item.role)) {
            console.warn(`  SKIP: invalid role '${item.role}' for USER#${userId} — must be one of: ${VALID_ROLES.join(', ')}`);
            skipped++;
            continue;
        }

        // Upsert the role record (idempotent — ON CONFLICT DO UPDATE via Prisma)
        await prisma.userTenantRole.upsert({
            where: {
                userId_tenantId: { userId, tenantId },
            },
            update: {
                email: item.email ?? '',
                role: item.role,
                assignedBy: item.assignedBy ?? 'migration',
                assignedAt: item.assignedAt ? new Date(item.assignedAt) : new Date(),
            },
            create: {
                userId,
                tenantId,
                email: item.email ?? '',
                role: item.role,
                assignedBy: item.assignedBy ?? 'migration',
                assignedAt: item.assignedAt ? new Date(item.assignedAt) : new Date(),
            },
        });

        count += 1;
        console.log(`Migrated ${count}/${total} records... (userId=${userId}, tenantId=${tenantId}, role=${item.role})`);
    }

    console.log(`\nMigration complete. Migrated ${count}/${total} RBAC records.`);
    if (skipped > 0) {
        console.log(`  Skipped ${skipped} records (malformed or invalid role).`);
    }
}

// ── Entry Point ───────────────────────────────────────────────────────────────

migrate()
    .catch((error: unknown) => {
        console.error('Migration failed:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

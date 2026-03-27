#!/usr/bin/env npx tsx
/**
 * migrate-accounts.ts
 *
 * Migrates all account records from DynamoDB NucleusAppTable (GSI1: TYPE#ACCOUNT)
 * to PostgreSQL accounts table.
 *
 * Prerequisites:
 *   - docker compose up -d postgres (PostgreSQL running locally)
 *   - npm run db:migrate (schema applied, run from web-ui/)
 *   - DATABASE_URL set in environment
 *   - AWS credentials available (AWS_PROFILE=PLATFORM-ADMIN or env vars)
 *
 * Usage:
 *   AWS_PROFILE=PLATFORM-ADMIN DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nucleus npx tsx scripts/migrate-accounts.ts
 *
 * Idempotent: safe to re-run — uses upsert (ON CONFLICT DO UPDATE via Prisma upsert).
 * Progress: prints "Migrated X/Y records..." after each upsert.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PrismaClient } from '@prisma/client';

// ── Configuration ─────────────────────────────────────────────────────────────

const APP_TABLE_NAME = process.env.APP_TABLE_NAME ?? process.env.DYNAMODB_TABLE_NAME;
const DATABASE_URL = process.env.DATABASE_URL;

if (!APP_TABLE_NAME) {
    console.error('ERROR: APP_TABLE_NAME (or DYNAMODB_TABLE_NAME) environment variable is required');
    process.exit(1);
}

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

interface DynamoAccountItem {
    pk?: string;
    sk?: string;
    tenantId?: string;
    accountId?: string;
    accountName?: string;
    roleArn?: string;
    externalId?: string;
    regions?: string[];
    active?: boolean;
    description?: string;
    connectionStatus?: string;
    connectionError?: string;
    createdAt?: string;
    updatedAt?: string;
    createdBy?: string;
    updatedBy?: string;
}

// ── DynamoDB Query (GSI1: TYPE#ACCOUNT) ───────────────────────────────────────

async function queryAllAccounts(): Promise<DynamoAccountItem[]> {
    const items: DynamoAccountItem[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const command = new QueryCommand({
            TableName: APP_TABLE_NAME as string,
            IndexName: 'GSI1',
            KeyConditionExpression: 'gsi1pk = :gsi1pk',
            ExpressionAttributeValues: {
                ':gsi1pk': 'TYPE#ACCOUNT',
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });

        const response = await dynamoClient.send(command);
        items.push(...((response.Items ?? []) as DynamoAccountItem[]));
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;

        if (lastEvaluatedKey) {
            console.log(`  Queried ${items.length} records so far, fetching next page...`);
        }
    } while (lastEvaluatedKey);

    return items;
}

// ── Migration Logic ───────────────────────────────────────────────────────────

async function migrate(): Promise<void> {
    console.log('Starting account migration: DynamoDB -> PostgreSQL');
    console.log(`  Source table: ${APP_TABLE_NAME} (GSI1: TYPE#ACCOUNT)`);
    console.log(`  AWS_PROFILE: ${process.env.AWS_PROFILE ?? '(default)'}`);
    console.log('');

    // Step 1: Query all account records from DynamoDB via GSI1
    console.log('Querying DynamoDB for account records (GSI1: TYPE#ACCOUNT)...');
    const items = await queryAllAccounts();
    const total = items.length;
    console.log(`Found ${total} account records to migrate.\n`);

    if (total === 0) {
        console.log('No records to migrate. Exiting.');
        return;
    }

    // Step 2: Upsert each record into PostgreSQL
    let count = 0;

    for (const item of items) {
        const tenantId = item.tenantId ?? item.pk?.replace('TENANT#', '') ?? 'org-default';
        const accountId = item.accountId ?? item.sk?.replace('ACCOUNT#', '');

        if (!accountId) {
            console.warn(`  SKIP: malformed item with no accountId — pk=${item.pk}, sk=${item.sk}`);
            continue;
        }

        // Upsert the account record (idempotent — ON CONFLICT DO UPDATE via Prisma)
        await prisma.account.upsert({
            where: {
                tenantId_accountId: { tenantId, accountId },
            },
            update: {
                name: item.accountName ?? accountId,
                roleArn: item.roleArn ?? '',
                externalId: item.externalId ?? null,
                regions: item.regions ?? [],
                active: item.active ?? true,
                description: item.description ?? null,
                connectionStatus: item.connectionStatus ?? 'unknown',
                connectionError: item.connectionError ?? null,
                updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                updatedBy: item.updatedBy ?? 'migration',
            },
            create: {
                tenantId,
                accountId,
                name: item.accountName ?? accountId,
                roleArn: item.roleArn ?? '',
                externalId: item.externalId ?? null,
                regions: item.regions ?? [],
                active: item.active ?? true,
                description: item.description ?? null,
                connectionStatus: item.connectionStatus ?? 'unknown',
                connectionError: item.connectionError ?? null,
                createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
                updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                createdBy: item.createdBy ?? 'migration',
                updatedBy: item.updatedBy ?? 'migration',
            },
        });

        count += 1;
        console.log(`Migrated ${count}/${total} records... (accountId=${accountId}, tenantId=${tenantId})`);
    }

    console.log(`\nMigration complete. Migrated ${count}/${total} account records.`);
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

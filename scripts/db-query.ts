#!/usr/bin/env npx tsx
/**
 * Read-only ad-hoc query helper against DATABASE_URL (the shared dev database
 * by default — see root .env). Prints JSON rows.
 *
 * Usage: bun run scripts/db-query.ts "SELECT * FROM rbac_role_rules LIMIT 5"
 *
 * Refuses anything that isn't a single SELECT/WITH statement — this script is
 * for survey queries only, never for writes.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
    log: ['error'],
});

function assertReadOnly(sql: string) {
    const trimmed = sql.trim().replace(/;+\s*$/, '');
    if (/;/.test(trimmed)) {
        throw new Error('Refusing multi-statement input — one SELECT/WITH statement only.');
    }
    if (!/^(select|with)\b/i.test(trimmed)) {
        throw new Error('Refusing non-SELECT/WITH statement — this script is read-only.');
    }
    return trimmed;
}

async function main() {
    const sql = process.argv[2];
    if (!sql) {
        console.error('Usage: bun run scripts/db-query.ts "<SELECT ...>"');
        process.exit(1);
    }
    const safeSql = assertReadOnly(sql);
    const rows = await prisma.$queryRawUnsafe(safeSql);
    console.log(JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2));
}

main()
    .catch((e) => {
        console.error(e.message);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());

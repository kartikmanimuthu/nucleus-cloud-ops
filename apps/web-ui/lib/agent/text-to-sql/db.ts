import { Pool, type PoolClient } from 'pg';
import type { SQLResult } from './state';
import { env } from '@/env';

let pool: Pool | null = null;

/**
 * Singleton pg Pool for text-to-sql agent queries.
 * Small pool (max 3) — only used for AI-generated read-only queries.
 * Separate from Prisma's connection pool.
 */
export function getTextToSQLPool(): Pool {
    if (!pool) {
        const connectionString = env.DATABASE_URL;
        if (!connectionString) throw new Error('DATABASE_URL is required for text-to-sql agent');
        pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
    }
    return pool;
}

/**
 * Execute a SQL query in a read-only transaction with statement timeout.
 * - BEGIN TRANSACTION READ ONLY — PostgreSQL blocks any writes
 * - SET LOCAL statement_timeout = 10000 — 10s max query time
 * - Parameterized: params[0] is always tenantId
 */
export async function executeReadOnlyQuery(sql: string, params: unknown[]): Promise<SQLResult> {
    const client: PoolClient = await getTextToSQLPool().connect();
    try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        await client.query('SET LOCAL statement_timeout = 10000');
        const result = await client.query(sql, params);
        await client.query('COMMIT');
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Execute a hardcoded schema introspection query (not LLM-generated).
 * Wrapped in read-only transaction for defense-in-depth.
 */
export async function executeSchemaQuery(sql: string): Promise<Record<string, unknown>[]> {
    const client: PoolClient = await getTextToSQLPool().connect();
    try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        const result = await client.query(sql);
        await client.query('COMMIT');
        return result.rows;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** Shut down the pool — call in test teardown. */
export async function closeTextToSQLPool(): Promise<void> {
    if (pool) { await pool.end(); pool = null; }
}

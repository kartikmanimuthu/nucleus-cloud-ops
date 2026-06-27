// workers/src/jobs/discovery/services/db.ts
// Shared pg Pool singleton — all discovery services use this to avoid
// creating multiple pools (3 × max:3 = 9 connections) from one process.
import { Pool } from 'pg';
import { env } from '../../../env.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const DATABASE_URL = env.DATABASE_URL;
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * PostgreSQL client singleton via Prisma ORM.
 * Mirrors the getDynamoDBDocumentClient() singleton pattern in aws-config.ts.
 *
 * Connection pool sizes (per architecture decision):
 *   - ECS (web-ui): connection_limit=10 — long-lived process
 *   - Lambda functions: set connection_limit=3 in DATABASE_URL query param
 *     (Lambda functions configure this in their own environment variables)
 *
 * Usage: import { getPrismaClient } from '@/lib/db/pg-config'
 */

import { PrismaClient } from '@prisma/client';

// Global singleton — Next.js hot reloads can create multiple instances in dev
// Use global object to prevent "Too many connections" in development
declare global {
    // eslint-disable-next-line no-var
    var __prismaClient: PrismaClient | undefined;
}

let prismaClient: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
    // In production, create once per process (ECS container, max 10 connections)
    if (process.env.NODE_ENV === 'production') {
        if (!prismaClient) {
            prismaClient = new PrismaClient({
                log: ['error'],
            });
        }
        return prismaClient;
    }

    // In development, reuse global to survive Next.js hot reloads
    if (!globalThis.__prismaClient) {
        globalThis.__prismaClient = new PrismaClient({
            log: ['query', 'error', 'warn'],
        });
    }
    return globalThis.__prismaClient;
}

/**
 * Disconnect the Prisma client — call in Lambda handler cleanup or test teardown.
 */
export async function disconnectPrisma(): Promise<void> {
    const client = prismaClient ?? globalThis.__prismaClient;
    if (client) {
        await client.$disconnect();
    }
}

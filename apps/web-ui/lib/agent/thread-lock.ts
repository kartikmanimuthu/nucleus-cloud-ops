import { randomUUID } from 'crypto';
import { getPrismaClient } from '@/lib/db/pg-config';

/**
 * Cross-instance per-thread execution lock (chat_thread_locks table).
 *
 * The web-ui service autoscales to multiple ECS tasks, so the previous
 * module-level `Map` only prevented duplicate LangGraph runs within a single
 * task. Two requests on the same thread routed to different tasks would both
 * run — doubling LLM cost and interleaving checkpoint writes on the same
 * thread_id (lost-update corruption). This lock is shared across all tasks.
 *
 * Uses raw SQL (not tenant-intercepted) keyed by the full threadId, which
 * already embeds the tenant. `expiresAt` (TTL) lets a crashed holder's lock be
 * reclaimed; `holder` ensures release() only removes the lock this request owns.
 */

// TTL must exceed the route's maxDuration (300s) so a long-but-live run isn't
// reclaimed mid-flight, with a small buffer for post-run persistence.
const LOCK_TTL_SECONDS = 360;

/**
 * Attempt to acquire the lock for `threadId`. Returns a holder token on success
 * (pass it to release), or null if another live request holds the lock.
 */
export async function acquireThreadLock(threadId: string): Promise<string | null> {
    const prisma = getPrismaClient();
    const token = randomUUID();
    try {
        // Fresh insert acquires; on conflict we only reclaim if the existing
        // lock has expired (crashed holder). A live lock leaves 0 rows → null.
        const rows = await prisma.$queryRaw<Array<{ threadId: string }>>`
            INSERT INTO chat_thread_locks ("threadId", "holder", "acquiredAt", "expiresAt")
            VALUES (${threadId}, ${token}, NOW(), NOW() + (${LOCK_TTL_SECONDS} * INTERVAL '1 second'))
            ON CONFLICT ("threadId") DO UPDATE
                SET "holder" = EXCLUDED."holder",
                    "acquiredAt" = NOW(),
                    "expiresAt" = EXCLUDED."expiresAt"
                WHERE chat_thread_locks."expiresAt" < NOW()
            RETURNING "threadId"
        `;
        return rows.length > 0 ? token : null;
    } catch (e) {
        // If the lock table is unavailable, fail OPEN (allow the request) rather
        // than hard-blocking chat — matches the prior in-memory behaviour on any
        // internal error. Logged so the misconfiguration is visible.
        console.error('[thread-lock] acquire failed, proceeding without lock:', e);
        return token;
    }
}

/** Release the lock iff this request still holds it (matches on holder token). */
export async function releaseThreadLock(threadId: string, token: string): Promise<void> {
    const prisma = getPrismaClient();
    try {
        await prisma.$executeRaw`
            DELETE FROM chat_thread_locks WHERE "threadId" = ${threadId} AND "holder" = ${token}
        `;
    } catch (e) {
        console.error('[thread-lock] release failed (lock will expire via TTL):', e);
    }
}

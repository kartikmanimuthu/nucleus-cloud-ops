import { getTenantClient } from '@/lib/db/pg-config';

const MAX_SESSIONS_PER_USER = 3;
const STALE_SESSION_MINUTES = 30;

export class ShellSessionService {
    /** Terminate sessions that have been idle longer than STALE_SESSION_MINUTES */
    static async reapStaleSessions(tenantId: string, userId: string) {
        const db = getTenantClient(tenantId);
        const cutoff = new Date(Date.now() - STALE_SESSION_MINUTES * 60 * 1000);

        const result = await db.shellSession.updateMany({
            where: {
                tenantId,
                userId,
                status: 'active',
                lastActiveAt: { lt: cutoff },
            },
            data: { status: 'terminated', terminatedAt: new Date() },
        });

        if (result.count > 0) {
            console.log(`[ShellSession] Reaped ${result.count} stale sessions for user ${userId}`);
        }

        return result.count;
    }

    static async createSession(
        tenantId: string,
        userId: string,
        options: { accountId?: string; accountName?: string; region?: string }
    ) {
        const db = getTenantClient(tenantId);

        // Auto-reap stale sessions before checking the limit
        await ShellSessionService.reapStaleSessions(tenantId, userId);

        const activeCount = await db.shellSession.count({
            where: { tenantId, userId, status: 'active' },
        });

        if (activeCount >= MAX_SESSIONS_PER_USER) {
            throw new Error(`Maximum concurrent sessions (${MAX_SESSIONS_PER_USER}) reached`);
        }

        return db.shellSession.create({
            data: {
                tenantId,
                userId,
                accountId: options.accountId ?? null,
                accountName: options.accountName ?? null,
                region: options.region ?? 'us-east-1',
                status: 'active',
                approvalMode: 'manual',
            },
        });
    }

    static async listSessions(tenantId: string, userId: string) {
        const db = getTenantClient(tenantId);
        return db.shellSession.findMany({
            where: { tenantId, userId, status: 'active' },
            orderBy: { startedAt: 'desc' },
        });
    }

    static async terminateSession(tenantId: string, userId: string, sessionId: string) {
        const db = getTenantClient(tenantId);

        const session = await db.shellSession.findFirst({
            where: { id: sessionId, tenantId, userId },
        });

        if (!session) {
            throw new Error('Session not found');
        }

        return db.shellSession.update({
            where: { id: sessionId },
            data: { status: 'terminated', terminatedAt: new Date() },
        });
    }

    static async touchSession(tenantId: string, sessionId: string) {
        const db = getTenantClient(tenantId);
        return db.shellSession.update({
            where: { id: sessionId },
            data: { lastActiveAt: new Date() },
        });
    }

    static async getSession(tenantId: string, sessionId: string) {
        const db = getTenantClient(tenantId);
        return db.shellSession.findFirst({
            where: { id: sessionId, tenantId },
        });
    }
}

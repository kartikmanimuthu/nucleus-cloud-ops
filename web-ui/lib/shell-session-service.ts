import { getTenantClient } from '@/lib/db/pg-config';

const MAX_SESSIONS_PER_USER = 3;

export class ShellSessionService {
    static async createSession(
        tenantId: string,
        userId: string,
        options: { accountId?: string; accountName?: string; region?: string }
    ) {
        const db = getTenantClient(tenantId);

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

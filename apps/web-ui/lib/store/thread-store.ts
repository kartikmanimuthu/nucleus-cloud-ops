import { getPrismaClient } from "@/lib/db/pg-config";

export interface Thread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    model?: string;
    ownerUserId?: string;
}

// ChatSession is NOT registered in TENANT_SCOPED_MODELS (its unique key is the
// global `sessionId`, which is incompatible with the tenant extension's
// findUnique injection). Every method here therefore scopes on tenantId
// MANUALLY — do not switch to getTenantClient without also solving the
// findUnique/upsert unique-key constraint.
export class ThreadStore {
    async listThreads(tenantId: string): Promise<Thread[]> {
        const prisma = getPrismaClient();
        const sessions = await prisma.chatSession.findMany({
            where: { tenantId },
            orderBy: { updatedAt: "desc" },
            take: 50,
        });
        return sessions.map((s) => ({
            id: s.sessionId,
            title: s.title,
            createdAt: s.createdAt.getTime(),
            updatedAt: s.updatedAt.getTime(),
            model: s.model ?? undefined,
            ownerUserId: s.userId,
        }));
    }

    async getThread(sessionId: string, tenantId: string): Promise<Thread | undefined> {
        const prisma = getPrismaClient();
        const s = await prisma.chatSession.findFirst({ where: { sessionId, tenantId } });
        if (!s) return undefined;
        return {
            id: s.sessionId,
            title: s.title,
            createdAt: s.createdAt.getTime(),
            updatedAt: s.updatedAt.getTime(),
            model: s.model ?? undefined,
            ownerUserId: s.userId,
        };
    }

    async createThread(
        sessionId: string,
        title: string = "New Chat",
        model?: string,
        tenantId?: string,
        userId?: string
    ): Promise<Thread> {
        const prisma = getPrismaClient();
        const resolvedTenantId = tenantId ?? "default";

        // Guard against cross-tenant collision on the globally-unique sessionId:
        // if a row with this sessionId already exists under a DIFFERENT tenant,
        // refuse rather than clobber it (bare/un-namespaced IDs could otherwise
        // let one tenant overwrite another tenant's session title/metadata).
        const existing = await prisma.chatSession.findUnique({ where: { sessionId } });
        if (existing && existing.tenantId !== resolvedTenantId) {
            throw new Error("Thread ID belongs to another tenant");
        }

        const s = await prisma.chatSession.upsert({
            where: { sessionId },
            create: {
                tenantId: resolvedTenantId,
                sessionId,
                userId: userId ?? "default",
                title,
                model,
            },
            update: { title, updatedAt: new Date() },
        });
        return {
            id: s.sessionId,
            title: s.title,
            createdAt: s.createdAt.getTime(),
            updatedAt: s.updatedAt.getTime(),
            model: s.model ?? undefined,
            ownerUserId: s.userId,
        };
    }

    async updateThread(
        sessionId: string,
        tenantId: string,
        updates: Partial<{ title: string; model: string }>
    ): Promise<Thread | undefined> {
        const prisma = getPrismaClient();
        // updateMany scopes on the (non-unique) tenantId filter and returns a count,
        // so a cross-tenant sessionId simply matches zero rows instead of updating.
        const res = await prisma.chatSession.updateMany({
            where: { sessionId, tenantId },
            data: {
                ...(updates.title !== undefined && { title: updates.title }),
                ...(updates.model !== undefined && { model: updates.model }),
                updatedAt: new Date(),
            },
        });
        if (res.count === 0) return undefined;
        return this.getThread(sessionId, tenantId);
    }

    async deleteThread(sessionId: string, tenantId: string): Promise<boolean> {
        const prisma = getPrismaClient();
        const res = await prisma.chatSession.deleteMany({ where: { sessionId, tenantId } });
        return res.count > 0;
    }
}

export const threadStore = new ThreadStore();

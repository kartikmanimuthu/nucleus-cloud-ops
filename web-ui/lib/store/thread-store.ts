import { getPrismaClient } from "@/lib/db/pg-config";

export interface Thread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    model?: string;
    ownerUserId?: string;
}

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

    async getThread(sessionId: string): Promise<Thread | undefined> {
        const prisma = getPrismaClient();
        const s = await prisma.chatSession.findUnique({ where: { sessionId } });
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
        const s = await prisma.chatSession.upsert({
            where: { sessionId },
            create: {
                tenantId: tenantId ?? "default",
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

    async updateThread(sessionId: string, updates: Partial<{ title: string; model: string }>): Promise<Thread | undefined> {
        const prisma = getPrismaClient();
        try {
            const s = await prisma.chatSession.update({
                where: { sessionId },
                data: {
                    ...(updates.title !== undefined && { title: updates.title }),
                    ...(updates.model !== undefined && { model: updates.model }),
                },
            });
            return {
                id: s.sessionId,
                title: s.title,
                createdAt: s.createdAt.getTime(),
                updatedAt: s.updatedAt.getTime(),
                model: s.model ?? undefined,
                ownerUserId: s.userId,
            };
        } catch {
            return undefined;
        }
    }

    async deleteThread(sessionId: string): Promise<boolean> {
        const prisma = getPrismaClient();
        try {
            await prisma.chatSession.delete({ where: { sessionId } });
            return true;
        } catch {
            return false;
        }
    }
}

export const threadStore = new ThreadStore();

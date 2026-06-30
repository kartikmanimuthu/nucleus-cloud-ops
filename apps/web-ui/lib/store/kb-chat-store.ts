import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/pg-config";
import type { KBSource } from "@/components/knowledge-base/kb-chat-sources";

// Knowledge Base "Ask AI" chat persistence (tenant-shared).
// Mirrors the agent ThreadStore pattern but is fully isolated from agent chat so the
// agent sidebar (/api/threads) never lists KB sessions. Listing/delete are scoped by
// tenantId only (sessions are visible to every member of the tenant). userId is kept
// for attribution. Messages carry retrieved sources in metadata for reload.

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface KbChatSessionDTO {
    id: string;
    title: string;
    knowledgeBaseId: string | null;
    createdAt: number;
    updatedAt: number;
    ownerUserId: string;
}

export interface KbAttachment {
    name: string;
    url: string; // data URL (data:<type>;base64,<data>)
}

export interface KbStoredMessage {
    role: "user" | "assistant";
    content: string;
    sources?: KBSource[];
    attachments?: KbAttachment[];
    createdAt?: number;
}

export class KbChatStore {
    async listSessions(tenantId: string): Promise<KbChatSessionDTO[]> {
        const prisma = getPrismaClient();
        const sessions = await prisma.kbChatSession.findMany({
            where: { tenantId },
            orderBy: { updatedAt: "desc" },
            take: 50,
        });
        return sessions.map((s) => ({
            id: s.sessionId,
            title: s.title,
            knowledgeBaseId: s.knowledgeBaseId ?? null,
            createdAt: s.createdAt.getTime(),
            updatedAt: s.updatedAt.getTime(),
            ownerUserId: s.userId,
        }));
    }

    async getSession(tenantId: string, sessionId: string): Promise<KbChatSessionDTO | undefined> {
        const prisma = getPrismaClient();
        const s = await prisma.kbChatSession.findFirst({ where: { sessionId, tenantId } });
        if (!s) return undefined;
        return {
            id: s.sessionId,
            title: s.title,
            knowledgeBaseId: s.knowledgeBaseId ?? null,
            createdAt: s.createdAt.getTime(),
            updatedAt: s.updatedAt.getTime(),
            ownerUserId: s.userId,
        };
    }

    async createSession(args: {
        sessionId: string;
        tenantId: string;
        userId: string;
        title?: string;
        knowledgeBaseId?: string | null;
    }): Promise<KbChatSessionDTO> {
        const prisma = getPrismaClient();
        const s = await prisma.kbChatSession.upsert({
            where: { sessionId: args.sessionId },
            create: {
                tenantId: args.tenantId,
                sessionId: args.sessionId,
                userId: args.userId,
                title: args.title?.trim() || "New Chat",
                knowledgeBaseId: args.knowledgeBaseId ?? null,
            },
            update: { updatedAt: new Date() },
        });
        return {
            id: s.sessionId,
            title: s.title,
            knowledgeBaseId: s.knowledgeBaseId ?? null,
            createdAt: s.createdAt.getTime(),
            updatedAt: s.updatedAt.getTime(),
            ownerUserId: s.userId,
        };
    }

    async touchSession(tenantId: string, sessionId: string): Promise<void> {
        const prisma = getPrismaClient();
        try {
            await prisma.kbChatSession.updateMany({
                where: { sessionId, tenantId },
                data: { updatedAt: new Date() },
            });
        } catch {
            /* ignore */
        }
    }

    async deleteSession(tenantId: string, sessionId: string): Promise<boolean> {
        const prisma = getPrismaClient();
        try {
            await prisma.kbChatMessage.deleteMany({ where: { tenantId, sessionId } });
            const res = await prisma.kbChatSession.deleteMany({ where: { tenantId, sessionId } });
            return res.count > 0;
        } catch {
            return false;
        }
    }

    async getMessages(tenantId: string, sessionId: string): Promise<KbStoredMessage[]> {
        const prisma = getPrismaClient();
        const rows = await prisma.kbChatMessage.findMany({
            where: { tenantId, sessionId },
            orderBy: { createdAt: "asc" },
        });
        return rows.map((r) => {
            const meta = (r.metadata as { sources?: KBSource[]; attachments?: KbAttachment[] } | null) ?? null;
            return {
                role: r.role === "assistant" ? "assistant" : "user",
                content: r.content,
                sources: meta?.sources,
                attachments: meta?.attachments,
                createdAt: r.createdAt.getTime(),
            } as KbStoredMessage;
        });
    }

    async addMessages(
        tenantId: string,
        sessionId: string,
        messages: KbStoredMessage[],
    ): Promise<void> {
        if (messages.length === 0) return;
        const prisma = getPrismaClient();
        const expiresAt = new Date(Date.now() + TTL_MS);
        await prisma.kbChatMessage.createMany({
            data: messages.map((m) => {
                const meta: { sources?: KBSource[]; attachments?: KbAttachment[] } = {};
                if (m.sources && m.sources.length > 0) meta.sources = m.sources;
                if (m.attachments && m.attachments.length > 0) meta.attachments = m.attachments;
                return {
                    tenantId,
                    sessionId,
                    role: m.role,
                    content: m.content,
                    metadata: Object.keys(meta).length > 0 ? (meta as Prisma.InputJsonValue) : undefined,
                    expiresAt,
                };
            }),
            skipDuplicates: true,
        });
    }
}

export const kbChatStore = new KbChatStore();

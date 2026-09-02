import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn() }));

import { getPrismaClient } from '@/lib/db/pg-config';
import { KbChatStore, kbChatStore } from './kb-chat-store';

const mockPrisma = {
    kbChatSession: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    kbChatMessage: { findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
};

const now = new Date('2026-01-01T00:00:00.000Z');
const dbSession = {
    sessionId: 's1', title: 'My Session', knowledgeBaseId: 'kb1',
    createdAt: now, updatedAt: now, userId: 'u1',
};

describe('KbChatStore', () => {
    let store: KbChatStore;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
        store = new KbChatStore();
    });

    it('listSessions maps rows to DTOs, ordered desc, capped at 50', async () => {
        mockPrisma.kbChatSession.findMany.mockResolvedValueOnce([dbSession]);
        const result = await store.listSessions('t1');

        expect(mockPrisma.kbChatSession.findMany).toHaveBeenCalledWith({
            where: { tenantId: 't1' }, orderBy: { updatedAt: 'desc' }, take: 50,
        });
        expect(result).toEqual([{
            id: 's1', title: 'My Session', knowledgeBaseId: 'kb1',
            createdAt: now.getTime(), updatedAt: now.getTime(), ownerUserId: 'u1',
        }]);
    });

    it('listSessions defaults a null knowledgeBaseId to null in the DTO', async () => {
        mockPrisma.kbChatSession.findMany.mockResolvedValueOnce([{ ...dbSession, knowledgeBaseId: null }]);
        const [result] = await store.listSessions('t1');
        expect(result.knowledgeBaseId).toBeNull();
    });

    it('getSession returns the mapped DTO on a hit, undefined on a miss', async () => {
        mockPrisma.kbChatSession.findFirst.mockResolvedValueOnce(dbSession);
        expect(await store.getSession('t1', 's1')).toEqual(expect.objectContaining({ id: 's1' }));

        mockPrisma.kbChatSession.findFirst.mockResolvedValueOnce(null);
        expect(await store.getSession('t1', 'missing')).toBeUndefined();
    });

    it('createSession upserts, defaulting an untitled/whitespace title to "New Chat"', async () => {
        mockPrisma.kbChatSession.upsert.mockResolvedValueOnce(dbSession);
        await store.createSession({ sessionId: 's1', tenantId: 't1', userId: 'u1', title: '   ' });

        expect(mockPrisma.kbChatSession.upsert).toHaveBeenCalledWith({
            where: { sessionId: 's1' },
            create: expect.objectContaining({ title: 'New Chat', knowledgeBaseId: null }),
            update: { updatedAt: expect.any(Date) },
        });
    });

    it('createSession trims a provided title and forwards knowledgeBaseId', async () => {
        mockPrisma.kbChatSession.upsert.mockResolvedValueOnce(dbSession);
        await store.createSession({ sessionId: 's1', tenantId: 't1', userId: 'u1', title: '  Hi  ', knowledgeBaseId: 'kb2' });

        expect(mockPrisma.kbChatSession.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ title: 'Hi', knowledgeBaseId: 'kb2' }),
        }));
    });

    it('touchSession bumps updatedAt and swallows errors', async () => {
        mockPrisma.kbChatSession.updateMany.mockResolvedValueOnce({ count: 1 });
        await expect(store.touchSession('t1', 's1')).resolves.toBeUndefined();

        mockPrisma.kbChatSession.updateMany.mockRejectedValueOnce(new Error('db down'));
        await expect(store.touchSession('t1', 's1')).resolves.toBeUndefined();
    });

    it('deleteSession deletes messages then the session, returning true when a row was removed', async () => {
        mockPrisma.kbChatMessage.deleteMany.mockResolvedValueOnce({ count: 3 });
        mockPrisma.kbChatSession.deleteMany.mockResolvedValueOnce({ count: 1 });
        expect(await store.deleteSession('t1', 's1')).toBe(true);
    });

    it('deleteSession returns false when no session row matched', async () => {
        mockPrisma.kbChatMessage.deleteMany.mockResolvedValueOnce({ count: 0 });
        mockPrisma.kbChatSession.deleteMany.mockResolvedValueOnce({ count: 0 });
        expect(await store.deleteSession('t1', 'missing')).toBe(false);
    });

    it('deleteSession swallows errors and returns false', async () => {
        mockPrisma.kbChatMessage.deleteMany.mockRejectedValueOnce(new Error('db down'));
        expect(await store.deleteSession('t1', 's1')).toBe(false);
    });

    it('getMessages maps rows, coercing role to user/assistant and pulling sources/attachments from metadata', async () => {
        mockPrisma.kbChatMessage.findMany.mockResolvedValueOnce([
            { role: 'assistant', content: 'hi', createdAt: now, metadata: { sources: [{ id: 'src1' }], attachments: [{ name: 'f', url: 'data:...' }] } },
            { role: 'system', content: 'weird role', createdAt: now, metadata: null },
        ]);
        const result = await store.getMessages('t1', 's1');

        expect(mockPrisma.kbChatMessage.findMany).toHaveBeenCalledWith({
            where: { tenantId: 't1', sessionId: 's1' }, orderBy: { createdAt: 'asc' },
        });
        expect(result[0]).toEqual(expect.objectContaining({ role: 'assistant', sources: [{ id: 'src1' }] }));
        expect(result[1].role).toBe('user'); // any non-'assistant' role coerces to 'user'
        expect(result[1].sources).toBeUndefined();
    });

    it('addMessages is a no-op for an empty array', async () => {
        await store.addMessages('t1', 's1', []);
        expect(mockPrisma.kbChatMessage.createMany).not.toHaveBeenCalled();
    });

    it('addMessages omits metadata entirely when there are no sources/attachments', async () => {
        mockPrisma.kbChatMessage.createMany.mockResolvedValueOnce({ count: 1 });
        await store.addMessages('t1', 's1', [{ role: 'user', content: 'hi' }]);

        expect(mockPrisma.kbChatMessage.createMany).toHaveBeenCalledWith({
            data: [expect.objectContaining({ tenantId: 't1', sessionId: 's1', role: 'user', content: 'hi', metadata: undefined })],
            skipDuplicates: true,
        });
    });

    it('addMessages includes metadata when sources or attachments are present', async () => {
        mockPrisma.kbChatMessage.createMany.mockResolvedValueOnce({ count: 1 });
        await store.addMessages('t1', 's1', [
            { role: 'assistant', content: 'answer', sources: [{ id: 'src1' } as any] },
        ]);

        expect(mockPrisma.kbChatMessage.createMany).toHaveBeenCalledWith(expect.objectContaining({
            data: [expect.objectContaining({ metadata: { sources: [{ id: 'src1' }] } })],
        }));
    });

    it('exports a shared singleton', () => {
        expect(kbChatStore).toBeInstanceOf(KbChatStore);
    });
});

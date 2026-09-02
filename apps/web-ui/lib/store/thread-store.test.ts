import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn() }));

import { getPrismaClient } from '@/lib/db/pg-config';
import { ThreadStore, threadStore } from './thread-store';

const mockPrisma = {
    chatSession: {
        findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(),
        upsert: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(),
    },
};

const now = new Date('2026-01-01T00:00:00.000Z');
const dbSession = {
    sessionId: 's1', title: 'My Chat', model: 'bedrock:claude',
    createdAt: now, updatedAt: now, userId: 'u1', tenantId: 't1',
};

describe('ThreadStore', () => {
    let store: ThreadStore;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
        store = new ThreadStore();
    });

    it('listThreads maps rows to Thread DTOs, ordered desc, capped at 50', async () => {
        mockPrisma.chatSession.findMany.mockResolvedValueOnce([dbSession]);
        const result = await store.listThreads('t1');

        expect(mockPrisma.chatSession.findMany).toHaveBeenCalledWith({
            where: { tenantId: 't1' }, orderBy: { updatedAt: 'desc' }, take: 50,
        });
        expect(result).toEqual([{
            id: 's1', title: 'My Chat', createdAt: now.getTime(), updatedAt: now.getTime(),
            model: 'bedrock:claude', ownerUserId: 'u1',
        }]);
    });

    it('listThreads maps a null model to undefined', async () => {
        mockPrisma.chatSession.findMany.mockResolvedValueOnce([{ ...dbSession, model: null }]);
        const [result] = await store.listThreads('t1');
        expect(result.model).toBeUndefined();
    });

    it('getThread returns the mapped thread on a hit, undefined on a miss', async () => {
        mockPrisma.chatSession.findFirst.mockResolvedValueOnce(dbSession);
        expect(await store.getThread('s1', 't1')).toEqual(expect.objectContaining({ id: 's1' }));
        expect(mockPrisma.chatSession.findFirst).toHaveBeenCalledWith({ where: { sessionId: 's1', tenantId: 't1' } });

        mockPrisma.chatSession.findFirst.mockResolvedValueOnce(null);
        expect(await store.getThread('missing', 't1')).toBeUndefined();
    });

    it('createThread upserts with defaults when title/model/tenantId/userId are omitted', async () => {
        mockPrisma.chatSession.findUnique.mockResolvedValueOnce(null);
        mockPrisma.chatSession.upsert.mockResolvedValueOnce({ ...dbSession, tenantId: 'default', userId: 'default' });

        await store.createThread('s1');

        expect(mockPrisma.chatSession.upsert).toHaveBeenCalledWith({
            where: { sessionId: 's1' },
            create: expect.objectContaining({ tenantId: 'default', userId: 'default', title: 'New Chat' }),
            update: { title: 'New Chat', updatedAt: expect.any(Date) },
        });
    });

    it('createThread proceeds when the existing row belongs to the same tenant (idempotent re-create)', async () => {
        mockPrisma.chatSession.findUnique.mockResolvedValueOnce({ ...dbSession, tenantId: 't1' });
        mockPrisma.chatSession.upsert.mockResolvedValueOnce(dbSession);

        await expect(store.createThread('s1', 'Renamed', 'm', 't1', 'u1')).resolves.toEqual(
            expect.objectContaining({ id: 's1' }),
        );
    });

    it('createThread refuses when the sessionId already belongs to a different tenant', async () => {
        mockPrisma.chatSession.findUnique.mockResolvedValueOnce({ ...dbSession, tenantId: 't-other' });

        await expect(store.createThread('s1', 'x', 'm', 't1', 'u1')).rejects.toThrow(
            'Thread ID belongs to another tenant',
        );
        expect(mockPrisma.chatSession.upsert).not.toHaveBeenCalled();
    });

    it('updateThread updates matching rows and returns the refreshed thread', async () => {
        mockPrisma.chatSession.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.chatSession.findFirst.mockResolvedValueOnce({ ...dbSession, title: 'Renamed' });

        const result = await store.updateThread('s1', 't1', { title: 'Renamed' });

        expect(mockPrisma.chatSession.updateMany).toHaveBeenCalledWith({
            where: { sessionId: 's1', tenantId: 't1' },
            data: { title: 'Renamed', updatedAt: expect.any(Date) },
        });
        expect(result?.title).toBe('Renamed');
    });

    it('updateThread returns undefined when no row matched (cross-tenant sessionId, or missing)', async () => {
        mockPrisma.chatSession.updateMany.mockResolvedValueOnce({ count: 0 });
        expect(await store.updateThread('s1', 't-other', { title: 'x' })).toBeUndefined();
        expect(mockPrisma.chatSession.findFirst).not.toHaveBeenCalled();
    });

    it('updateThread only includes fields that were actually provided', async () => {
        mockPrisma.chatSession.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.chatSession.findFirst.mockResolvedValueOnce(dbSession);
        await store.updateThread('s1', 't1', { model: 'new-model' });

        expect(mockPrisma.chatSession.updateMany).toHaveBeenCalledWith({
            where: { sessionId: 's1', tenantId: 't1' },
            data: { model: 'new-model', updatedAt: expect.any(Date) },
        });
    });

    it('deleteThread returns true when a row was removed, false otherwise', async () => {
        mockPrisma.chatSession.deleteMany.mockResolvedValueOnce({ count: 1 });
        expect(await store.deleteThread('s1', 't1')).toBe(true);

        mockPrisma.chatSession.deleteMany.mockResolvedValueOnce({ count: 0 });
        expect(await store.deleteThread('missing', 't1')).toBe(false);
    });

    it('exports a shared singleton', () => {
        expect(threadStore).toBeInstanceOf(ThreadStore);
    });
});

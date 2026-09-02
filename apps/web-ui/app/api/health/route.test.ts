import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
}));

import { getPrismaClient } from '@/lib/db/pg-config';
import { GET, HEAD } from './route';

describe('GET /api/health', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 200 healthy when the database responds', async () => {
        const mockQueryRaw = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
        vi.mocked(getPrismaClient).mockReturnValue({ $queryRaw: mockQueryRaw } as any);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.status).toBe('healthy');
        expect(body.database).toBe('connected');
        expect(body.service).toBe('web-ui');
        expect(typeof body.timestamp).toBe('string');
    });

    it('returns 207 degraded when the database query throws', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            $queryRaw: vi.fn().mockRejectedValue(new Error('connection refused')),
        } as any);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(207);
        expect(body.status).toBe('degraded');
        expect(body.database).toEqual({ status: 'error', error: 'connection refused' });
    });

    it('returns 207 degraded with a generic message for a non-Error rejection', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            $queryRaw: vi.fn().mockRejectedValue('raw string failure'),
        } as any);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(207);
        expect(body.database).toEqual({ status: 'error', error: 'Unknown error' });
    });
});

describe('HEAD /api/health', () => {
    it('returns 200 with no body', async () => {
        const res = await HEAD();
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toBe('');
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getAuthSession: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn() }));

import { getAuthSession } from '@/lib/auth-session';
import { getPrismaClient } from '@/lib/db/pg-config';
import { GET } from './route';

const makeRequest = (url: string) => ({ nextUrl: new URL(url) }) as any;

describe('GET /api/tenants/check-slug', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1' } } as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getAuthSession).mockResolvedValue(null as any);

        const res = await GET(makeRequest('http://localhost/api/tenants/check-slug?slug=acme'));
        expect(res.status).toBe(401);
    });

    it('returns 400 when slug param is missing', async () => {
        const res = await GET(makeRequest('http://localhost/api/tenants/check-slug'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('slug parameter required');
    });

    it('returns 400 for an invalid slug format', async () => {
        const res = await GET(makeRequest('http://localhost/api/tenants/check-slug?slug=AB'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.available).toBe(false);
    });

    it('returns available: true when no tenant has the slug', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            tenant: { findUnique: vi.fn().mockResolvedValue(null) },
        } as any);

        const res = await GET(makeRequest('http://localhost/api/tenants/check-slug?slug=acme-corp'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.available).toBe(true);
    });

    it('returns available: false when the slug is taken', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'existing' }) },
        } as any);

        const res = await GET(makeRequest('http://localhost/api/tenants/check-slug?slug=acme-corp'));
        const body = await res.json();

        expect(body.available).toBe(false);
    });

    it('returns 500 when the database call throws', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            tenant: { findUnique: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await GET(makeRequest('http://localhost/api/tenants/check-slug?slug=acme-corp'));
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toBe('Internal server error');
    });
});

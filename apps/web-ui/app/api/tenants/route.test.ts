import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getAuthSession: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { getAuthSession } from '@/lib/auth-session';
import { getPrismaClient } from '@/lib/db/pg-config';
import { AuditService } from '@/lib/audit-service';
import { POST } from './route';

const makeRequest = (body: unknown) =>
    ({ json: vi.fn().mockResolvedValue(body) }) as any;

const SESSION = { user: { id: 'u1', email: 'a@b.co' } };

function makeTx(overrides: Record<string, unknown> = {}) {
    return {
        tenant: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'tenant-1', slug: 'acme' }),
        },
        customRole: { findFirst: vi.fn().mockResolvedValue({ id: 'role-owner' }) },
        userTenantRole: { create: vi.fn().mockResolvedValue({}) },
        ...overrides,
    };
}

function makePrisma(tx: ReturnType<typeof makeTx>) {
    return {
        $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
        authUser: { update: vi.fn().mockResolvedValue({}) },
    };
}

describe('POST /api/tenants', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getAuthSession).mockResolvedValue(SESSION as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getAuthSession).mockResolvedValue(null as any);

        const res = await POST(makeRequest({ name: 'Acme', slug: 'acme' }));
        const body = await res.json();

        expect(res.status).toBe(401);
        expect(body.error).toBe('Unauthenticated');
    });

    it('returns 400 for an invalid slug', async () => {
        const res = await POST(makeRequest({ name: 'Acme', slug: 'AB' }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(typeof body.error).toBe('string');
    });

    it('returns 400 when name is missing', async () => {
        const res = await POST(makeRequest({ slug: 'acme-corp' }));
        expect(res.status).toBe(400);
    });

    it('creates the tenant, assigns Owner, switches active tenant, and returns 201', async () => {
        const tx = makeTx();
        const prisma = makePrisma(tx);
        vi.mocked(getPrismaClient).mockReturnValue(prisma as any);

        const res = await POST(makeRequest({ name: 'Acme', slug: 'acme' }));
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(body).toEqual({ success: true, tenantId: 'tenant-1', slug: 'acme' });
        expect(tx.tenant.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ name: 'Acme', slug: 'acme', status: 'active' }) })
        );
        expect(tx.userTenantRole.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ userId: 'u1', tenantId: 'tenant-1', role: 'Owner', roleId: 'role-owner' }),
            })
        );
        expect(prisma.authUser.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { activeTenantId: 'tenant-1' },
        });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'tenant.organization.created', status: 'success' })
        );
    });

    it('returns 409 when the slug is already taken', async () => {
        const tx = makeTx({ tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'existing' }), create: vi.fn() } });
        vi.mocked(getPrismaClient).mockReturnValue(makePrisma(tx) as any);

        const res = await POST(makeRequest({ name: 'Acme', slug: 'acme' }));
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.error).toContain('already taken');
        expect(tx.tenant.create).not.toHaveBeenCalled();
    });

    it('returns 500 and logs a failure audit event on unexpected error', async () => {
        const prisma = { $transaction: vi.fn().mockRejectedValue(new Error('DB exploded')) };
        vi.mocked(getPrismaClient).mockReturnValue(prisma as any);

        const res = await POST(makeRequest({ name: 'Acme', slug: 'acme' }));
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toContain('Failed to create organization');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'error', details: expect.stringContaining('DB exploded') })
        );
    });
});

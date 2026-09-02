import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getAuthSession: vi.fn(), getSessionTenantId: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));
vi.mock('@/lib/rbac/registry', () => ({ loadAssignablePrincipalAttributes: vi.fn() }));
vi.mock('@/lib/rbac/registry-service', () => ({ runRbacMutation: vi.fn() }));

import { authorize } from '@/lib/rbac/authorize';
import { getAuthSession, getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';
import { loadAssignablePrincipalAttributes } from '@/lib/rbac/registry';
import { runRbacMutation } from '@/lib/rbac/registry-service';
import { GET, PUT } from './route';

const makeParams = (memberId: string) => ({ params: Promise.resolve({ memberId }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/settings/members/[memberId]/attributes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET({} as any, makeParams('member-1'));
        expect(res).toBe(authError);
    });

    it('returns 404 when the member does not exist', async () => {
        vi.mocked(getTenantClient).mockReturnValue({
            userTenantRole: { findUnique: vi.fn().mockResolvedValue(null) },
        } as any);

        const res = await GET({} as any, makeParams('member-missing'));
        expect(res.status).toBe(404);
    });

    it('returns assignable attribute keys and current values', async () => {
        vi.mocked(getTenantClient).mockReturnValue({
            userTenantRole: { findUnique: vi.fn().mockResolvedValue({ userId: 'u1', email: 'a@b.co' }) },
            rbacUserAttribute: {
                findMany: vi.fn().mockResolvedValue([{ key: 'allowedAccountIds', value: ['acc-1'] }]),
            },
        } as any);
        vi.mocked(loadAssignablePrincipalAttributes).mockResolvedValue([
            { key: 'allowedAccountIds', valueType: 'string[]' } as any,
        ]);

        const res = await GET({} as any, makeParams('member-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({
            userId: 'u1',
            email: 'a@b.co',
            assignable: [{ key: 'allowedAccountIds', valueType: 'string[]' }],
            values: { allowedAccountIds: ['acc-1'] },
        });
    });

    it('returns 500 when the database call throws', async () => {
        vi.mocked(getTenantClient).mockReturnValue({
            userTenantRole: { findUnique: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await GET({} as any, makeParams('member-1'));
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/settings/members/[memberId]/attributes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'actor-1', email: 'actor@x.com' } } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            userTenantRole: { findUnique: vi.fn().mockResolvedValue({ userId: 'u1', email: 'a@b.co' }) },
            rbacUserAttribute: { findMany: vi.fn().mockResolvedValue([]) },
        } as any);
        vi.mocked(loadAssignablePrincipalAttributes).mockResolvedValue([
            { key: 'allowedAccountIds', valueType: 'string[]' } as any,
            { key: 'maxSpend', valueType: 'number' } as any,
        ]);
        vi.mocked(runRbacMutation).mockImplementation(async (_input, work) => {
            const tx = {
                rbacUserAttribute: { upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({}) },
            };
            return work(tx as any);
        });
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await PUT(makeRequest({ values: { allowedAccountIds: ['a'] } }), makeParams('member-1'));
        expect(res).toBe(authError);
    });

    it('returns 400 when values is missing or not an object', async () => {
        const res = await PUT(makeRequest({}), makeParams('member-1'));
        expect(res.status).toBe(400);
    });

    it('returns 404 when the member does not exist', async () => {
        vi.mocked(getTenantClient).mockReturnValue({
            userTenantRole: { findUnique: vi.fn().mockResolvedValue(null) },
        } as any);

        const res = await PUT(makeRequest({ values: { allowedAccountIds: ['a'] } }), makeParams('member-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 400 for a key the registry does not declare as assignable', async () => {
        const res = await PUT(makeRequest({ values: { notARealKey: 'x' } }), makeParams('member-1'));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toContain('notARealKey');
        expect(runRbacMutation).not.toHaveBeenCalled();
    });

    it('returns 400 when a value does not match the declared type', async () => {
        const res = await PUT(makeRequest({ values: { maxSpend: 'not-a-number' } }), makeParams('member-1'));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toContain('maxSpend');
    });

    it('accepts a null value to clear an attribute', async () => {
        const res = await PUT(makeRequest({ values: { maxSpend: null } }), makeParams('member-1'));
        expect(res.status).toBe(200);
    });

    it('validates string, boolean, and date attribute types', async () => {
        vi.mocked(loadAssignablePrincipalAttributes).mockResolvedValue([
            { key: 'costCenter', valueType: 'string' } as any,
            { key: 'isContractor', valueType: 'boolean' } as any,
            { key: 'accessExpiresAt', valueType: 'date' } as any,
        ]);

        const res = await PUT(
            makeRequest({ values: { costCenter: 'eng-1', isContractor: true, accessExpiresAt: '2026-01-01' } }),
            makeParams('member-1')
        );
        expect(res.status).toBe(200);
    });

    it('returns 400 for a value type not declared by any known valueType (default case)', async () => {
        vi.mocked(loadAssignablePrincipalAttributes).mockResolvedValue([
            { key: 'weirdField', valueType: 'unsupported-type' } as any,
        ]);

        const res = await PUT(makeRequest({ values: { weirdField: 'anything' } }), makeParams('member-1'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('weirdField');
    });

    it('includes existing attribute rows in the audit "before" snapshot', async () => {
        vi.mocked(getTenantClient).mockReturnValue({
            userTenantRole: { findUnique: vi.fn().mockResolvedValue({ userId: 'u1', email: 'a@b.co' }) },
            rbacUserAttribute: {
                findMany: vi.fn().mockResolvedValue([{ key: 'maxSpend', value: 100 }]),
            },
        } as any);

        const res = await PUT(makeRequest({ values: { maxSpend: 200 } }), makeParams('member-1'));
        expect(res.status).toBe(200);
        expect(runRbacMutation).toHaveBeenCalledWith(
            expect.objectContaining({ before: { maxSpend: 100 } }),
            expect.any(Function)
        );
    });

    it('runs the mutation and returns the updated values on success', async () => {
        const res = await PUT(
            makeRequest({ values: { allowedAccountIds: ['acc-1', 'acc-2'] }, reason: 'contractor scoping' }),
            makeParams('member-1')
        );
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({ userId: 'u1', values: { allowedAccountIds: ['acc-1', 'acc-2'] } });
        expect(runRbacMutation).toHaveBeenCalledWith(
            expect.objectContaining({
                actor: { userId: 'actor-1', email: 'actor@x.com', tenantId: 'tenant-1' },
                entityType: 'userAttribute',
                entityId: 'u1',
                operation: 'update',
                reason: 'contractor scoping',
            }),
            expect.any(Function)
        );
    });

    it('returns 500 when runRbacMutation throws', async () => {
        vi.mocked(runRbacMutation).mockRejectedValue(new Error('lockout guard tripped'));

        const res = await PUT(makeRequest({ values: { allowedAccountIds: ['a'] } }), makeParams('member-1'));
        expect(res.status).toBe(500);
    });
});

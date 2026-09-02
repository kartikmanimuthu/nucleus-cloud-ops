import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/rbac/custom-role-service', () => ({
    createCustomRole: vi.fn(), getCustomRoles: vi.fn(), getPresetRoles: vi.fn(),
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { createCustomRole, getCustomRoles, getPresetRoles } from '@/lib/rbac/custom-role-service';
import { AuditService } from '@/lib/audit-service';
import { GET, POST } from './route';

const VALID_BODY = { name: 'Editor', permissions: { Account: ['read'] } };
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/settings/roles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET({} as any);
        expect(res).toBe(authError);
        expect(getCustomRoles).not.toHaveBeenCalled();
    });

    it('fetches predefined and custom roles scoped by tenant', async () => {
        vi.mocked(getCustomRoles).mockResolvedValue([{ id: 'r1' }] as any);
        vi.mocked(getPresetRoles).mockResolvedValue([{ id: 'admin' }] as any);

        const res = await GET({} as any);
        const body = await res.json();

        expect(getCustomRoles).toHaveBeenCalledWith('tenant-1');
        expect(getPresetRoles).toHaveBeenCalledWith('tenant-1');
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ predefined: [{ id: 'admin' }], custom: [{ id: 'r1' }] });
    });

    it('returns 500 when fetching roles fails', async () => {
        vi.mocked(getCustomRoles).mockRejectedValue(new Error('DB down'));
        vi.mocked(getPresetRoles).mockResolvedValue([]);
        const res = await GET({} as any);
        expect(res.status).toBe(500);
    });
});

describe('POST /api/settings/roles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', email: 'a@b.co' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest(VALID_BODY));
        expect(res).toBe(authError);
        expect(createCustomRole).not.toHaveBeenCalled();
    });

    it('returns 400 when name is blank', async () => {
        const res = await POST(makeRequest({ ...VALID_BODY, name: '  ' }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when name exceeds 50 characters', async () => {
        const res = await POST(makeRequest({ ...VALID_BODY, name: 'x'.repeat(51) }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when permissions is missing', async () => {
        const res = await POST(makeRequest({ name: 'Editor' }));
        expect(res.status).toBe(400);
    });

    it('creates the role, scoped by tenant, and logs a high-severity audit event', async () => {
        vi.mocked(createCustomRole).mockResolvedValue({ id: 'r1', name: 'Editor' } as any);

        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(createCustomRole).toHaveBeenCalledWith(
            'tenant-1',
            { name: 'Editor', permissions: { Account: ['read'] }, overrides: {} },
            { userId: 'u1', email: 'a@b.co' },
        );
        expect(res.status).toBe(201);
        expect(body.data).toEqual({ id: 'r1', name: 'Editor' });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'rbac.role.created', severity: 'high', status: 'success' })
        );
    });

    it('returns 409 and logs a failure audit event on a conflict message', async () => {
        vi.mocked(createCustomRole).mockRejectedValue(new Error('A role with this name already exists'));

        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(409);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });

    it('returns 500 for a non-conflict error', async () => {
        vi.mocked(createCustomRole).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(500);
    });
});

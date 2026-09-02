import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));

import { getServerSession } from 'next-auth';
import {
    getAuthSession, getSessionTenantId, getSessionUserId, getSessionUserEmail, assertSuperAdmin,
} from './auth-session';

beforeEach(() => {
    vi.mocked(getServerSession).mockReset();
});

describe('getAuthSession', () => {
    it('returns the full session object as-is', async () => {
        const session = { user: { id: 'u1', tenantId: 't1' } };
        vi.mocked(getServerSession).mockResolvedValue(session as any);
        expect(await getAuthSession()).toBe(session);
    });

    it('returns null when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        expect(await getAuthSession()).toBeNull();
    });
});

describe('getSessionTenantId', () => {
    it('returns the tenantId from a valid session', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: 't1' } } as any);
        expect(await getSessionTenantId()).toBe('t1');
    });

    it('throws Unauthenticated when there is no session at all', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        await expect(getSessionTenantId()).rejects.toThrow('Unauthenticated: no valid session');
    });

    it('throws Unauthenticated when the session has no user', async () => {
        vi.mocked(getServerSession).mockResolvedValue({} as any);
        await expect(getSessionTenantId()).rejects.toThrow('Unauthenticated: no valid session');
    });

    it('throws Unauthorized when the user has no tenant', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'u1', tenantId: null } } as any);
        await expect(getSessionTenantId()).rejects.toThrow('Unauthorized: no tenant associated with session');
    });
});

describe('getSessionUserId', () => {
    it('returns the id prefixed with USER# for legacy compatibility', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'u1' } } as any);
        expect(await getSessionUserId()).toBe('USER#u1');
    });

    it('throws Unauthenticated when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        await expect(getSessionUserId()).rejects.toThrow('Unauthenticated: no valid session');
    });

    it('throws Unauthenticated when the session user has no id', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: {} } as any);
        await expect(getSessionUserId()).rejects.toThrow('Unauthenticated: no valid session');
    });
});

describe('getSessionUserEmail', () => {
    it('returns the raw email for audit-trail attribution', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        expect(await getSessionUserEmail()).toBe('a@b.co');
    });

    it('throws Unauthenticated when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        await expect(getSessionUserEmail()).rejects.toThrow('Unauthenticated: no valid session');
    });

    it('throws Unauthenticated when the session user has no email', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'u1' } } as any);
        await expect(getSessionUserEmail()).rejects.toThrow('Unauthenticated: no valid session');
    });
});

describe('assertSuperAdmin', () => {
    it('returns null (authorized) for an isSuperAdmin user', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: { isSuperAdmin: true } } as any);
        expect(await assertSuperAdmin()).toBeNull();
    });

    it('returns 401 when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await assertSuperAdmin();
        expect(res?.status).toBe(401);
        const body = await res?.json();
        expect(body).toEqual({ error: 'Unauthenticated', message: 'No valid session' });
    });

    it('returns 403 when the session user is not a super admin', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: { isSuperAdmin: false } } as any);
        const res = await assertSuperAdmin();
        expect(res?.status).toBe(403);
        const body = await res?.json();
        expect(body).toEqual({ error: 'Forbidden', message: 'Super admin access required' });
    });

    it('returns 403 when isSuperAdmin is present but not strictly true', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: { isSuperAdmin: 1 } } as any);
        const res = await assertSuperAdmin();
        expect(res?.status).toBe(403);
    });
});

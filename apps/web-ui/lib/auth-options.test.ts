import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
    mockPrisma: {
        authUser: { findUnique: vi.fn(), update: vi.fn() },
        userTenantRole: { findFirst: vi.fn() },
        tenant: { findUnique: vi.fn() },
    },
}));

vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => mockPrisma }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { createAuditLog: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('bcryptjs', () => ({ default: { compare: vi.fn() } }));
vi.mock('@/lib/invitation-service', () => ({ InvitationService: { acceptPendingInvitation: vi.fn() } }));
vi.mock('@/env', () => ({
    env: {
        NODE_ENV: 'test',
        NEXTAUTH_SECRET: 'test-secret',
        COGNITO_APP_CLIENT_ID: 'client-id',
        COGNITO_APP_CLIENT_SECRET: 'client-secret',
        COGNITO_ISSUER: 'https://cognito.example.com',
    },
}));

import bcrypt from 'bcryptjs';
import { AuditService } from '@/lib/audit-service';
import { InvitationService } from '@/lib/invitation-service';
import { authOptions } from './auth-options';

const credentialsProvider = authOptions.providers.find((p: any) => p.id === 'credentials') as any;
const authorize = credentialsProvider.options.authorize as (
    creds: Record<string, unknown> | undefined
) => Promise<unknown>;

describe('auth-options credentials authorize', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns null when email or password is missing', async () => {
        expect(await authorize({ email: 'a@b.co' })).toBeNull();
        expect(await authorize({ password: 'x' })).toBeNull();
        expect(await authorize(undefined)).toBeNull();
        expect(mockPrisma.authUser.findUnique).not.toHaveBeenCalled();
    });

    it('returns null when the user does not exist', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue(null);
        const result = await authorize({ email: 'a@b.co', password: 'pw' });
        expect(result).toBeNull();
    });

    it('throws an SSO message for a Cognito-only user with no password hash', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue({ id: 'u1', passwordHash: null });
        await expect(authorize({ email: 'a@b.co', password: 'pw' })).rejects.toThrow('SSO');
    });

    it('throws a lockout message with plural minutes when still locked', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue({
            id: 'u1',
            passwordHash: 'hash',
            lockedUntil: new Date(Date.now() + 5 * 60 * 1000),
        });
        await expect(authorize({ email: 'a@b.co', password: 'pw' })).rejects.toThrow(/5 minutes/);
    });

    it('throws a lockout message with singular minute when exactly 1 minute remains', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue({
            id: 'u1',
            passwordHash: 'hash',
            lockedUntil: new Date(Date.now() + 30 * 1000), // rounds up to 1 minute
        });
        await expect(authorize({ email: 'a@b.co', password: 'pw' })).rejects.toThrow('1 minute.');
    });

    it('proceeds past an expired lockout', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue({
            id: 'u1',
            email: 'a@b.co',
            passwordHash: 'hash',
            lockedUntil: new Date(Date.now() - 1000),
            failedAttempts: 3,
        });
        vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
        mockPrisma.authUser.update.mockResolvedValue({});

        const result = await authorize({ email: 'a@b.co', password: 'pw' });
        expect(result).toMatchObject({ id: 'u1' });
    });

    it('increments failedAttempts and audit-logs a failed attempt below the lockout threshold', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue({
            id: 'u1',
            email: 'a@b.co',
            passwordHash: 'hash',
            lockedUntil: null,
            failedAttempts: 2,
        });
        vi.mocked(bcrypt.compare).mockResolvedValue(false as never);
        mockPrisma.authUser.update.mockResolvedValue({});
        mockPrisma.userTenantRole.findFirst.mockResolvedValue({ tenantId: 'tenant-1' });

        const result = await authorize({ email: 'a@b.co', password: 'wrong' });

        expect(result).toBeNull();
        expect(mockPrisma.authUser.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { failedAttempts: 3 },
        });
        expect(AuditService.createAuditLog).toHaveBeenCalledWith(
            expect.objectContaining({
                eventType: 'auth.session.login_failed',
                severity: 'high',
                tenantId: 'tenant-1',
            })
        );
    });

    it('locks the account and audit-logs a critical event on the 5th failed attempt', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue({
            id: 'u1',
            email: 'a@b.co',
            passwordHash: 'hash',
            lockedUntil: null,
            failedAttempts: 4,
        });
        vi.mocked(bcrypt.compare).mockResolvedValue(false as never);
        mockPrisma.authUser.update.mockResolvedValue({});
        mockPrisma.userTenantRole.findFirst.mockResolvedValue(null);

        const result = await authorize({ email: 'a@b.co', password: 'wrong' });

        expect(result).toBeNull();
        expect(mockPrisma.authUser.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { failedAttempts: 5, lockedUntil: expect.any(Date) },
        });
        expect(AuditService.createAuditLog).toHaveBeenCalledWith(
            expect.objectContaining({ severity: 'critical', tenantId: 'unknown' })
        );
    });

    it('does not let a rejected audit log throw out of authorize', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue({
            id: 'u1', email: 'a@b.co', passwordHash: 'hash', lockedUntil: null, failedAttempts: 0,
        });
        vi.mocked(bcrypt.compare).mockResolvedValue(false as never);
        mockPrisma.authUser.update.mockResolvedValue({});
        mockPrisma.userTenantRole.findFirst.mockResolvedValue({ tenantId: 't1' });
        vi.mocked(AuditService.createAuditLog).mockRejectedValue(new Error('audit down'));

        await expect(authorize({ email: 'a@b.co', password: 'wrong' })).resolves.toBeNull();
    });

    it('resets lockout state and returns the user on a successful login', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue({
            id: 'u1', email: 'a@b.co', passwordHash: 'hash', lockedUntil: null, failedAttempts: 2, isSuperAdmin: true,
        });
        vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
        mockPrisma.authUser.update.mockResolvedValue({});

        const result = await authorize({ email: 'a@b.co', password: 'right' });

        expect(mockPrisma.authUser.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { failedAttempts: 0, lockedUntil: null },
        });
        expect(result).toEqual({
            id: 'u1', email: 'a@b.co', isSuperAdmin: true, failedAttempts: 0, lockedUntil: null,
        });
    });
});

describe('auth-options jwt callback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('re-queries tenant info on initial sign-in using the user-provided activeTenantId', async () => {
        mockPrisma.userTenantRole.findFirst.mockResolvedValue({ tenantId: 'tenant-1', role: 'admin' });
        mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Acme' });

        const token: any = {};
        const result = await authOptions.callbacks!.jwt!({
            token,
            user: { id: 'u1', email: 'a@b.co', activeTenantId: 'tenant-1', isSuperAdmin: true } as any,
        } as any);

        expect(mockPrisma.userTenantRole.findFirst).toHaveBeenCalledWith({
            where: { userId: 'u1', tenantId: 'tenant-1' },
        });
        expect(result.tenantId).toBe('tenant-1');
        expect(result.role).toBe('admin');
        expect(result.tenantName).toBe('Acme');
        expect(result.isSuperAdmin).toBe(true);
        expect(result.email).toBe('a@b.co');
    });

    it('falls back to the most recent tenant membership when no activeTenantId is set', async () => {
        mockPrisma.userTenantRole.findFirst.mockResolvedValue({ tenantId: 'tenant-2', role: 'member' });
        mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Beta' });

        const token: any = {};
        await authOptions.callbacks!.jwt!({ token, user: { id: 'u1' } as any } as any);

        expect(mockPrisma.userTenantRole.findFirst).toHaveBeenCalledWith({
            where: { userId: 'u1' },
            orderBy: { assignedAt: 'desc' },
        });
    });

    it('re-fetches activeTenantId from the DB on a session-update trigger with no user', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue({ activeTenantId: 'tenant-3' });
        mockPrisma.userTenantRole.findFirst.mockResolvedValue({ tenantId: 'tenant-3', role: 'owner' });
        mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Gamma' });

        const token: any = { sub: 'u1' };
        const result = await authOptions.callbacks!.jwt!({ token, trigger: 'update' } as any);

        expect(mockPrisma.authUser.findUnique).toHaveBeenCalledWith({
            where: { id: 'u1' },
            select: { activeTenantId: true },
        });
        expect(result.tenantId).toBe('tenant-3');
    });

    it('sets tenantId and tenantName to null when the user has no tenant membership', async () => {
        mockPrisma.userTenantRole.findFirst.mockResolvedValue(null);

        const token: any = {};
        const result = await authOptions.callbacks!.jwt!({ token, user: { id: 'u1' } as any } as any);

        expect(result.tenantId).toBeNull();
        expect(result.tenantName).toBeNull();
        expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
    });

    it('accepts a pending invitation on first login with no tenant membership', async () => {
        mockPrisma.userTenantRole.findFirst
            .mockResolvedValueOnce(null) // initial lookup
            .mockResolvedValueOnce({ tenantId: 'tenant-4', role: 'member' }); // post-acceptance lookup
        mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Delta' });
        vi.mocked(InvitationService.acceptPendingInvitation).mockResolvedValue(undefined as any);

        const token: any = {};
        const result = await authOptions.callbacks!.jwt!({
            token, user: { id: 'u1', email: 'a@b.co' } as any,
        } as any);

        expect(InvitationService.acceptPendingInvitation).toHaveBeenCalledWith('u1', 'a@b.co');
        expect(result.tenantId).toBe('tenant-4');
    });

    it('swallows a failed invitation acceptance and leaves the token without a tenant', async () => {
        mockPrisma.userTenantRole.findFirst.mockResolvedValue(null);
        vi.mocked(InvitationService.acceptPendingInvitation).mockRejectedValue(new Error('bad invite'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const token: any = {};
        const result = await authOptions.callbacks!.jwt!({
            token, user: { id: 'u1', email: 'a@b.co' } as any,
        } as any);

        expect(result.tenantId).toBeNull();
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it('leaves activeTenantId null when the session-update DB lookup has none set either', async () => {
        mockPrisma.authUser.findUnique.mockResolvedValue({ activeTenantId: null });
        mockPrisma.userTenantRole.findFirst.mockResolvedValue(null);

        const token: any = { sub: 'u1' };
        const result = await authOptions.callbacks!.jwt!({ token, trigger: 'update' } as any);

        expect(mockPrisma.userTenantRole.findFirst).toHaveBeenCalledWith({
            where: { userId: 'u1' },
            orderBy: { assignedAt: 'desc' },
        });
        expect(result.tenantId).toBeNull();
    });

    it('falls back to a null tenant name when the tenant record has none', async () => {
        mockPrisma.userTenantRole.findFirst.mockResolvedValue({ tenantId: 'tenant-5', role: 'member' });
        mockPrisma.tenant.findUnique.mockResolvedValue(null);

        const token: any = {};
        const result = await authOptions.callbacks!.jwt!({ token, user: { id: 'u1' } as any } as any);

        expect(result.tenantName).toBeNull();
    });

    it('leaves the token unchanged when neither user nor an update trigger is present', async () => {
        const token: any = { tenantId: 'existing', foo: 'bar' };
        const result = await authOptions.callbacks!.jwt!({ token } as any);
        expect(result).toBe(token);
        expect(mockPrisma.userTenantRole.findFirst).not.toHaveBeenCalled();
    });
});

describe('auth-options session callback', () => {
    it('maps JWT token fields onto session.user', async () => {
        const token: any = {
            sub: 'u1', email: 'a@b.co', tenantId: 'tenant-1', tenantName: 'Acme', role: 'admin', isSuperAdmin: true,
        };
        const session: any = {};
        const result = await authOptions.callbacks!.session!({ session, token } as any);

        expect(result.user).toEqual({
            id: 'u1', email: 'a@b.co', tenantId: 'tenant-1', tenantName: 'Acme', role: 'admin', isSuperAdmin: true,
        });
    });

    it('defaults missing token fields', async () => {
        const token: any = { sub: 'u1' };
        const session: any = {};
        const result = await authOptions.callbacks!.session!({ session, token } as any);

        expect(result.user).toEqual({
            id: 'u1', email: '', tenantId: null, tenantName: null, role: null, isSuperAdmin: false,
        });
    });
});

describe('auth-options redirect callback', () => {
    const baseUrl = 'https://app.example.com';

    it('allows a relative callback URL', async () => {
        const result = await authOptions.callbacks!.redirect!({ url: '/dashboard', baseUrl } as any);
        expect(result).toBe('https://app.example.com/dashboard');
    });

    it('allows an absolute URL on the same origin', async () => {
        const result = await authOptions.callbacks!.redirect!({ url: 'https://app.example.com/settings', baseUrl } as any);
        expect(result).toBe('https://app.example.com/settings');
    });

    it('falls back to baseUrl for a cross-origin URL', async () => {
        const result = await authOptions.callbacks!.redirect!({ url: 'https://evil.example.com/phish', baseUrl } as any);
        expect(result).toBe(baseUrl);
    });
});

describe('auth-options events', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('signIn logs the login with the resolved tenant and provider', async () => {
        mockPrisma.userTenantRole.findFirst.mockResolvedValue({ tenantId: 'tenant-1' });
        await authOptions.events!.signIn!({
            user: { id: 'u1', email: 'a@b.co' } as any,
            account: { provider: 'cognito' } as any,
        } as any);

        expect(AuditService.createAuditLog).toHaveBeenCalledWith(
            expect.objectContaining({
                eventType: 'auth.session.login', tenantId: 'tenant-1',
                metadata: { provider: 'cognito', userId: 'u1' },
            })
        );
    });

    it('signIn defaults to "credentials" and "unknown" tenant when account/tenant are absent', async () => {
        mockPrisma.userTenantRole.findFirst.mockResolvedValue(null);
        await authOptions.events!.signIn!({ user: { id: 'u1' } as any, account: null } as any);

        expect(AuditService.createAuditLog).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId: 'unknown', user: 'u1',
                metadata: { provider: 'credentials', userId: 'u1' },
            })
        );
    });

    it('signIn swallows a rejected audit log', async () => {
        mockPrisma.userTenantRole.findFirst.mockResolvedValue({ tenantId: 'tenant-1' });
        vi.mocked(AuditService.createAuditLog).mockRejectedValue(new Error('down'));
        await expect(
            authOptions.events!.signIn!({ user: { id: 'u1', email: 'a@b.co' } as any, account: {} as any } as any)
        ).resolves.toBeUndefined();
    });

    it('signOut logs with token fields when present', async () => {
        await authOptions.events!.signOut!({
            token: { sub: 'u1', email: 'a@b.co', tenantId: 'tenant-1' } as any,
        } as any);

        expect(AuditService.createAuditLog).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'auth.session.logout', tenantId: 'tenant-1', user: 'a@b.co' })
        );
    });

    it('signOut falls back to userId then "unknown" when email/tenant are absent', async () => {
        await authOptions.events!.signOut!({ token: { sub: 'u1' } as any } as any);

        expect(AuditService.createAuditLog).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'unknown', user: 'u1' })
        );
    });

    it('signOut swallows a rejected audit log', async () => {
        vi.mocked(AuditService.createAuditLog).mockRejectedValue(new Error('down'));
        await expect(authOptions.events!.signOut!({ token: undefined } as any)).resolves.toBeUndefined();
    });
});

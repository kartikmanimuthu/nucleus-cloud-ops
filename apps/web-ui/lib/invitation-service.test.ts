import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('bcryptjs', () => ({ default: { hash: vi.fn().mockResolvedValue('hashed-pw') } }));
vi.mock('@/lib/cognito-client', () => ({ getCognitoClient: vi.fn(), COGNITO_USER_POOL_ID: 'pool-1' }));
vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
    AdminCreateUserCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    AdminDeleteUserCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    AdminDisableUserCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn(), getTenantClient: vi.fn() }));

import { getCognitoClient } from '@/lib/cognito-client';
import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';
import { InvitationService } from './invitation-service';

const mockTenantPrisma = { invitation: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() } };
const mockGlobalPrisma = {
    userTenantRole: { findFirst: vi.fn(), create: vi.fn() },
    authUser: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), upsert: vi.fn() },
    customRole: { findFirst: vi.fn() },
    invitation: { findMany: vi.fn(), update: vi.fn() },
};
const mockCognito = { send: vi.fn() };

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTenantClient).mockReturnValue(mockTenantPrisma as any);
    vi.mocked(getPrismaClient).mockReturnValue(mockGlobalPrisma as any);
    vi.mocked(getCognitoClient).mockReturnValue(mockCognito as any);
    mockCognito.send.mockResolvedValue({});
    mockGlobalPrisma.authUser.delete.mockResolvedValue(undefined);
});

describe('createInvitation', () => {
    it('rejects a duplicate pending invitation for the same email', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue({ id: 'inv-1' });
        await expect(InvitationService.createInvitation('t1', 'a@b.co', 'Member', 'admin@b.co'))
            .rejects.toThrow('An invitation is already pending');
    });

    it('rejects when the email already belongs to a member of this tenant', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue(null);
        mockGlobalPrisma.userTenantRole.findFirst.mockResolvedValue({ userId: 'u1' });
        await expect(InvitationService.createInvitation('t1', 'a@b.co', 'Member', 'admin@b.co'))
            .rejects.toThrow('already a member');
    });

    it('auto-joins an existing user with an active membership elsewhere (D-08)', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue(null);
        mockGlobalPrisma.userTenantRole.findFirst
            .mockResolvedValueOnce(null) // not already a member of THIS tenant
            .mockResolvedValueOnce({ userId: 'u1' }); // has SOME active membership
        mockGlobalPrisma.authUser.findUnique.mockResolvedValue({ id: 'u1' });
        mockGlobalPrisma.customRole.findFirst.mockResolvedValue({ id: 'role-1' });
        mockTenantPrisma.invitation.create.mockResolvedValue({ id: 'inv-1', status: 'accepted' });

        const result = await InvitationService.createInvitation('t1', 'a@b.co', 'Member', 'admin@b.co');

        expect(mockGlobalPrisma.userTenantRole.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ userId: 'u1', tenantId: 't1', role: 'Member', roleId: 'role-1' }),
        }));
        expect(result).toEqual({ invitation: { id: 'inv-1', status: 'accepted' }, autoJoined: true });
        expect(getCognitoClient).not.toHaveBeenCalled();
    });

    it('creates a new AuthUser and Cognito user for a brand-new email (D-04)', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue(null);
        mockGlobalPrisma.userTenantRole.findFirst.mockResolvedValueOnce(null);
        mockGlobalPrisma.authUser.findUnique.mockResolvedValue(null); // no existing AuthUser at all
        mockTenantPrisma.invitation.create.mockResolvedValue({ id: 'inv-1', status: 'pending' });

        const result = await InvitationService.createInvitation('t1', 'new@b.co', 'Viewer', 'admin@b.co');

        expect(mockGlobalPrisma.authUser.create).toHaveBeenCalledWith({ data: { email: 'new@b.co', passwordHash: 'hashed-pw' } });
        expect(mockCognito.send).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ invitation: { id: 'inv-1', status: 'pending' }, autoJoined: false });
    });

    it('updates an existing AuthUser (from a prior failed attempt) instead of re-creating it', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue(null);
        mockGlobalPrisma.userTenantRole.findFirst.mockResolvedValueOnce(null); // not a member of this tenant
        mockGlobalPrisma.authUser.findUnique
            .mockResolvedValueOnce({ id: 'u1' }) // hasActiveMembership check target
            .mockResolvedValueOnce({ id: 'u1' }); // existingAuthUser check before Cognito call
        mockGlobalPrisma.userTenantRole.findFirst.mockResolvedValueOnce(null); // hasActiveMembership → false (no membership anywhere)
        mockTenantPrisma.invitation.create.mockResolvedValue({ id: 'inv-1', status: 'pending' });

        await InvitationService.createInvitation('t1', 'existing@b.co', 'Viewer', 'admin@b.co');

        expect(mockGlobalPrisma.authUser.update).toHaveBeenCalledWith({ where: { email: 'existing@b.co' }, data: { passwordHash: 'hashed-pw' } });
        expect(mockGlobalPrisma.authUser.create).not.toHaveBeenCalled();
    });

    it('deletes and re-creates the Cognito user on UsernameExistsException', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue(null);
        mockGlobalPrisma.userTenantRole.findFirst.mockResolvedValueOnce(null);
        mockGlobalPrisma.authUser.findUnique.mockResolvedValue(null);
        mockTenantPrisma.invitation.create.mockResolvedValue({ id: 'inv-1' });
        mockCognito.send
            .mockRejectedValueOnce({ __type: 'UsernameExistsException' })
            .mockResolvedValueOnce({}) // delete
            .mockResolvedValueOnce({}); // re-create

        await InvitationService.createInvitation('t1', 'dup@b.co', 'Viewer', 'admin@b.co');
        expect(mockCognito.send).toHaveBeenCalledTimes(3);
    });

    it('rolls back the newly-created AuthUser when Cognito fails unrecoverably', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue(null);
        mockGlobalPrisma.userTenantRole.findFirst.mockResolvedValueOnce(null);
        mockGlobalPrisma.authUser.findUnique.mockResolvedValue(null);
        mockCognito.send.mockRejectedValue(new Error('Cognito is down'));

        await expect(InvitationService.createInvitation('t1', 'fail@b.co', 'Viewer', 'admin@b.co'))
            .rejects.toThrow('Cognito is down');
        expect(mockGlobalPrisma.authUser.delete).toHaveBeenCalledWith({ where: { email: 'fail@b.co' } });
    });

    it('does not roll back a pre-existing AuthUser when Cognito fails', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue(null);
        mockGlobalPrisma.userTenantRole.findFirst.mockResolvedValueOnce(null);
        mockGlobalPrisma.authUser.findUnique
            .mockResolvedValueOnce({ id: 'u1' })
            .mockResolvedValueOnce({ id: 'u1' });
        mockGlobalPrisma.userTenantRole.findFirst.mockResolvedValueOnce(null);
        mockCognito.send.mockRejectedValue(new Error('Cognito is down'));

        await expect(InvitationService.createInvitation('t1', 'existing@b.co', 'Viewer', 'admin@b.co')).rejects.toThrow();
        expect(mockGlobalPrisma.authUser.delete).not.toHaveBeenCalled();
    });
});

describe('listInvitations', () => {
    it('marks stale pending invitations as expired', async () => {
        const now = Date.now();
        mockTenantPrisma.invitation.findMany.mockResolvedValue([
            { id: 'inv-1', status: 'pending', expiresAt: new Date(now - 1000) },
            { id: 'inv-2', status: 'pending', expiresAt: new Date(now + 100_000) },
        ]);

        const result = await InvitationService.listInvitations('t1');

        expect(mockTenantPrisma.invitation.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ['inv-1'] }, status: 'pending' }, data: { status: 'expired' },
        });
        expect(result.find(i => i.id === 'inv-1')?.status).toBe('expired');
        expect(result.find(i => i.id === 'inv-2')?.status).toBe('pending');
    });

    it('skips the update when nothing has expired', async () => {
        mockTenantPrisma.invitation.findMany.mockResolvedValue([{ id: 'inv-1', status: 'accepted', expiresAt: new Date() }]);
        await InvitationService.listInvitations('t1');
        expect(mockTenantPrisma.invitation.updateMany).not.toHaveBeenCalled();
    });
});

describe('resendInvitation', () => {
    it('throws when the invitation is not pending or does not exist', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue(null);
        await expect(InvitationService.resendInvitation('inv-1', 't1')).rejects.toThrow('not found or not in pending');
    });

    it('rotates the temp password and re-sends via Cognito', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue({ id: 'inv-1', email: 'a@b.co' });
        mockTenantPrisma.invitation.update.mockResolvedValue({ id: 'inv-1', expiresAt: new Date() });

        await InvitationService.resendInvitation('inv-1', 't1');

        expect(mockGlobalPrisma.authUser.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { email: 'a@b.co' }, update: { passwordHash: 'hashed-pw' },
        }));
        expect(mockCognito.send).toHaveBeenCalledTimes(2); // delete + create
    });

    it('tolerates the Cognito user not existing on delete', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue({ id: 'inv-1', email: 'a@b.co' });
        mockTenantPrisma.invitation.update.mockResolvedValue({ id: 'inv-1' });
        mockCognito.send.mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce({});

        await expect(InvitationService.resendInvitation('inv-1', 't1')).resolves.toBeDefined();
    });
});

describe('revokeInvitation', () => {
    it('throws when the invitation is not pending or does not exist', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue(null);
        await expect(InvitationService.revokeInvitation('inv-1', 't1')).rejects.toThrow('not found or not in pending');
    });

    it('disables the Cognito user and marks the invitation revoked', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue({ id: 'inv-1', email: 'a@b.co' });
        mockTenantPrisma.invitation.update.mockResolvedValue({ id: 'inv-1', status: 'revoked' });

        const result = await InvitationService.revokeInvitation('inv-1', 't1');

        expect(mockTenantPrisma.invitation.update).toHaveBeenCalledWith({ where: { id: 'inv-1' }, data: { status: 'revoked' } });
        expect(result).toEqual({ id: 'inv-1', status: 'revoked' });
    });

    it('still revokes the invitation when the Cognito user no longer exists', async () => {
        mockTenantPrisma.invitation.findFirst.mockResolvedValue({ id: 'inv-1', email: 'a@b.co' });
        mockCognito.send.mockRejectedValue(new Error('user not found'));
        mockTenantPrisma.invitation.update.mockResolvedValue({ id: 'inv-1', status: 'revoked' });

        await expect(InvitationService.revokeInvitation('inv-1', 't1')).resolves.toEqual({ id: 'inv-1', status: 'revoked' });
    });
});

describe('acceptPendingInvitation', () => {
    it('creates the UserTenantRole and marks the invitation accepted when no role exists yet', async () => {
        mockGlobalPrisma.invitation.findMany.mockResolvedValue([
            { id: 'inv-1', tenantId: 't1', role: 'Member', invitedBy: 'admin@b.co' },
        ]);
        mockGlobalPrisma.userTenantRole.findFirst.mockResolvedValue(null);
        mockGlobalPrisma.customRole.findFirst.mockResolvedValue({ id: 'role-1' });

        await InvitationService.acceptPendingInvitation('u1', 'a@b.co');

        expect(mockGlobalPrisma.userTenantRole.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ userId: 'u1', tenantId: 't1', role: 'Member', roleId: 'role-1' }),
        }));
        expect(mockGlobalPrisma.invitation.update).toHaveBeenCalledWith({ where: { id: 'inv-1' }, data: { status: 'accepted' } });
    });

    it('skips creating a duplicate UserTenantRole when one already exists', async () => {
        mockGlobalPrisma.invitation.findMany.mockResolvedValue([{ id: 'inv-1', tenantId: 't1', role: 'Member', invitedBy: 'admin@b.co' }]);
        mockGlobalPrisma.userTenantRole.findFirst.mockResolvedValue({ id: 'existing-role' });

        await InvitationService.acceptPendingInvitation('u1', 'a@b.co');

        expect(mockGlobalPrisma.userTenantRole.create).not.toHaveBeenCalled();
        expect(mockGlobalPrisma.invitation.update).toHaveBeenCalledWith({ where: { id: 'inv-1' }, data: { status: 'accepted' } });
    });

    it('continues processing remaining invitations when one fails', async () => {
        mockGlobalPrisma.invitation.findMany.mockResolvedValue([
            { id: 'inv-1', tenantId: 't1', role: 'Member', invitedBy: 'admin@b.co' },
            { id: 'inv-2', tenantId: 't2', role: 'Viewer', invitedBy: 'admin@b.co' },
        ]);
        mockGlobalPrisma.userTenantRole.findFirst
            .mockRejectedValueOnce(new Error('DB down'))
            .mockResolvedValueOnce(null);
        mockGlobalPrisma.customRole.findFirst.mockResolvedValue(null);

        await InvitationService.acceptPendingInvitation('u1', 'a@b.co');

        expect(mockGlobalPrisma.invitation.update).toHaveBeenCalledWith({ where: { id: 'inv-2' }, data: { status: 'accepted' } });
        expect(mockGlobalPrisma.invitation.update).not.toHaveBeenCalledWith({ where: { id: 'inv-1' }, data: { status: 'accepted' } });
    });

    it('does nothing when there are no pending invitations', async () => {
        mockGlobalPrisma.invitation.findMany.mockResolvedValue([]);
        await InvitationService.acceptPendingInvitation('u1', 'a@b.co');
        expect(mockGlobalPrisma.userTenantRole.create).not.toHaveBeenCalled();
    });
});

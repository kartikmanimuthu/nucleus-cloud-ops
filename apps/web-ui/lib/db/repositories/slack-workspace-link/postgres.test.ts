import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindUnique, mockUpsert, mockFindFirst, mockDeleteMany } = vi.hoisted(() => ({
    mockFindUnique: vi.fn(), mockUpsert: vi.fn(), mockFindFirst: vi.fn(), mockDeleteMany: vi.fn(),
}));

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: () => ({
        slackWorkspaceLink: {
            findUnique: mockFindUnique, upsert: mockUpsert, findFirst: mockFindFirst, deleteMany: mockDeleteMany,
        },
    }),
}));

import { SlackWorkspaceLinkPostgresRepository } from './postgres';
import { SlackWorkspaceLinkConflictError } from './interface';

const repo = new SlackWorkspaceLinkPostgresRepository();

beforeEach(() => {
    vi.clearAllMocks();
});

describe('findTenantIdByTeamId', () => {
    it('resolves the owning tenantId — deliberately unscoped, since this IS the scope resolution', async () => {
        mockFindUnique.mockResolvedValue({ tenantId: 'tenant-1' });
        expect(await repo.findTenantIdByTeamId('T123')).toBe('tenant-1');
        expect(mockFindUnique).toHaveBeenCalledWith({ where: { teamId: 'T123' }, select: { tenantId: true } });
    });

    it('returns null for an unlinked team', async () => {
        mockFindUnique.mockResolvedValue(null);
        expect(await repo.findTenantIdByTeamId('T-unknown')).toBeNull();
    });

    it('wraps a DB failure in a descriptive error', async () => {
        mockFindUnique.mockRejectedValue(new Error('connection reset'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.findTenantIdByTeamId('T123')).rejects.toThrow('Failed to resolve Slack team_id: connection reset');
        consoleSpy.mockRestore();
    });

    it('stringifies a non-Error throw in the wrapped message', async () => {
        mockFindUnique.mockRejectedValue('raw string failure');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.findTenantIdByTeamId('T123')).rejects.toThrow('Failed to resolve Slack team_id: raw string failure');
        consoleSpy.mockRestore();
    });
});

describe('upsertLink', () => {
    it('creates a new link with a null botUserId by default', async () => {
        mockFindUnique.mockResolvedValue(null);
        mockUpsert.mockResolvedValue({});
        await repo.upsertLink({ teamId: 'T123', tenantId: 'tenant-1' });
        expect(mockUpsert).toHaveBeenCalledWith({
            where: { teamId: 'T123' }, update: { botUserId: null }, create: { teamId: 'T123', tenantId: 'tenant-1', botUserId: null },
        });
    });

    it('passes through an explicit botUserId', async () => {
        mockFindUnique.mockResolvedValue(null);
        mockUpsert.mockResolvedValue({});
        await repo.upsertLink({ teamId: 'T123', tenantId: 'tenant-1', botUserId: 'B1' });
        expect(mockUpsert.mock.calls[0][0].create.botUserId).toBe('B1');
    });

    it('re-links the same tenant idempotently without conflict', async () => {
        mockFindUnique.mockResolvedValue({ tenantId: 'tenant-1' });
        mockUpsert.mockResolvedValue({});
        await expect(repo.upsertLink({ teamId: 'T123', tenantId: 'tenant-1' })).resolves.toBeUndefined();
        expect(mockUpsert).toHaveBeenCalledOnce();
    });

    it('throws SlackWorkspaceLinkConflictError when the team is already linked to a different tenant, without upserting', async () => {
        mockFindUnique.mockResolvedValue({ tenantId: 'tenant-other' });
        await expect(repo.upsertLink({ teamId: 'T123', tenantId: 'tenant-1' })).rejects.toThrow(SlackWorkspaceLinkConflictError);
        expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('re-throws the conflict error as-is, not wrapped in a generic message', async () => {
        mockFindUnique.mockResolvedValue({ tenantId: 'tenant-other' });
        await expect(repo.upsertLink({ teamId: 'T123', tenantId: 'tenant-1' })).rejects.toThrow(
            'Slack workspace "T123" is already linked to a different tenant',
        );
    });

    it('wraps a DB failure in a descriptive error', async () => {
        mockFindUnique.mockResolvedValue(null);
        mockUpsert.mockRejectedValue(new Error('write failed'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.upsertLink({ teamId: 'T123', tenantId: 'tenant-1' })).rejects.toThrow('Failed to link Slack workspace: write failed');
        consoleSpy.mockRestore();
    });

    it('stringifies a non-Error throw in the wrapped message', async () => {
        mockFindUnique.mockResolvedValue(null);
        mockUpsert.mockRejectedValue('raw failure');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.upsertLink({ teamId: 'T123', tenantId: 'tenant-1' })).rejects.toThrow('Failed to link Slack workspace: raw failure');
        consoleSpy.mockRestore();
    });
});

describe('getLinkForTenant', () => {
    it('scopes the lookup by tenantId and returns the mapped record', async () => {
        mockFindFirst.mockResolvedValue({ teamId: 'T123', tenantId: 'tenant-1', botUserId: 'B1' });
        const result = await repo.getLinkForTenant('tenant-1');
        expect(mockFindFirst).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' } });
        expect(result).toEqual({ teamId: 'T123', tenantId: 'tenant-1', botUserId: 'B1' });
    });

    it('returns null when the tenant has no link', async () => {
        mockFindFirst.mockResolvedValue(null);
        expect(await repo.getLinkForTenant('tenant-1')).toBeNull();
    });

    it('wraps a DB failure in a descriptive error', async () => {
        mockFindFirst.mockRejectedValue(new Error('timeout'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.getLinkForTenant('tenant-1')).rejects.toThrow('Failed to get Slack workspace link: timeout');
        consoleSpy.mockRestore();
    });

    it('stringifies a non-Error throw in the wrapped message', async () => {
        mockFindFirst.mockRejectedValue('raw failure');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.getLinkForTenant('tenant-1')).rejects.toThrow('Failed to get Slack workspace link: raw failure');
        consoleSpy.mockRestore();
    });
});

describe('deleteLinkForTenant', () => {
    it('scopes the delete by tenantId and returns the deleted count', async () => {
        mockDeleteMany.mockResolvedValue({ count: 1 });
        expect(await repo.deleteLinkForTenant('tenant-1')).toBe(1);
        expect(mockDeleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' } });
    });

    it('returns 0 without logging when nothing was linked', async () => {
        mockDeleteMany.mockResolvedValue({ count: 0 });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        expect(await repo.deleteLinkForTenant('tenant-1')).toBe(0);
        expect(consoleSpy).not.toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it('wraps a DB failure in a descriptive error', async () => {
        mockDeleteMany.mockRejectedValue(new Error('locked'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.deleteLinkForTenant('tenant-1')).rejects.toThrow('Failed to unlink Slack workspace: locked');
        consoleSpy.mockRestore();
    });

    it('stringifies a non-Error throw in the wrapped message', async () => {
        mockDeleteMany.mockRejectedValue('raw failure');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.deleteLinkForTenant('tenant-1')).rejects.toThrow('Failed to unlink Slack workspace: raw failure');
        consoleSpy.mockRestore();
    });
});

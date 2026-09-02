import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindUnique, mockUpsert, mockFindFirst, mockDeleteMany } = vi.hoisted(() => ({
    mockFindUnique: vi.fn(), mockUpsert: vi.fn(), mockFindFirst: vi.fn(), mockDeleteMany: vi.fn(),
}));

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: () => ({
        telegramBotLink: {
            findUnique: mockFindUnique, upsert: mockUpsert, findFirst: mockFindFirst, deleteMany: mockDeleteMany,
        },
    }),
}));

import { TelegramBotLinkPostgresRepository } from './postgres';
import { TelegramBotLinkConflictError } from './interface';

const repo = new TelegramBotLinkPostgresRepository();

beforeEach(() => {
    vi.clearAllMocks();
});

describe('findTenantIdBySecretToken', () => {
    it('resolves the owning tenantId — deliberately unscoped, since this IS the scope resolution', async () => {
        mockFindUnique.mockResolvedValue({ tenantId: 'tenant-1' });
        expect(await repo.findTenantIdBySecretToken('secret-1')).toBe('tenant-1');
        expect(mockFindUnique).toHaveBeenCalledWith({ where: { secretToken: 'secret-1' }, select: { tenantId: true } });
    });

    it('returns null for an unrecognized secret token', async () => {
        mockFindUnique.mockResolvedValue(null);
        expect(await repo.findTenantIdBySecretToken('unknown')).toBeNull();
    });

    it('wraps a DB failure in a descriptive error', async () => {
        mockFindUnique.mockRejectedValue(new Error('connection reset'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.findTenantIdBySecretToken('secret-1')).rejects.toThrow('Failed to resolve Telegram secret token: connection reset');
        consoleSpy.mockRestore();
    });

    it('stringifies a non-Error throw in the wrapped message', async () => {
        mockFindUnique.mockRejectedValue('raw failure');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.findTenantIdBySecretToken('secret-1')).rejects.toThrow('Failed to resolve Telegram secret token: raw failure');
        consoleSpy.mockRestore();
    });
});

describe('upsertLink', () => {
    it('creates a new link', async () => {
        mockFindUnique.mockResolvedValue(null);
        mockUpsert.mockResolvedValue({});
        await repo.upsertLink({ secretToken: 'secret-1', tenantId: 'tenant-1' });
        expect(mockUpsert).toHaveBeenCalledWith({
            where: { secretToken: 'secret-1' }, update: {}, create: { secretToken: 'secret-1', tenantId: 'tenant-1' },
        });
    });

    it('re-links the same tenant idempotently without conflict', async () => {
        mockFindUnique.mockResolvedValue({ tenantId: 'tenant-1' });
        mockUpsert.mockResolvedValue({});
        await expect(repo.upsertLink({ secretToken: 'secret-1', tenantId: 'tenant-1' })).resolves.toBeUndefined();
        expect(mockUpsert).toHaveBeenCalledOnce();
    });

    it('throws TelegramBotLinkConflictError when the token is already linked to a different tenant, without upserting', async () => {
        mockFindUnique.mockResolvedValue({ tenantId: 'tenant-other' });
        await expect(repo.upsertLink({ secretToken: 'secret-1', tenantId: 'tenant-1' })).rejects.toThrow(TelegramBotLinkConflictError);
        expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('re-throws the conflict error as-is, not wrapped in a generic message', async () => {
        mockFindUnique.mockResolvedValue({ tenantId: 'tenant-other' });
        await expect(repo.upsertLink({ secretToken: 'secret-1', tenantId: 'tenant-1' })).rejects.toThrow(
            'This secret token is already linked to a different tenant',
        );
    });

    it('wraps a DB failure in a descriptive error', async () => {
        mockFindUnique.mockResolvedValue(null);
        mockUpsert.mockRejectedValue(new Error('write failed'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.upsertLink({ secretToken: 'secret-1', tenantId: 'tenant-1' })).rejects.toThrow('Failed to link Telegram bot: write failed');
        consoleSpy.mockRestore();
    });

    it('stringifies a non-Error throw in the wrapped message', async () => {
        mockFindUnique.mockResolvedValue(null);
        mockUpsert.mockRejectedValue('raw failure');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.upsertLink({ secretToken: 'secret-1', tenantId: 'tenant-1' })).rejects.toThrow('Failed to link Telegram bot: raw failure');
        consoleSpy.mockRestore();
    });
});

describe('getLinkForTenant', () => {
    it('scopes the lookup by tenantId and returns the mapped record', async () => {
        mockFindFirst.mockResolvedValue({ secretToken: 'secret-1', tenantId: 'tenant-1' });
        const result = await repo.getLinkForTenant('tenant-1');
        expect(mockFindFirst).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' } });
        expect(result).toEqual({ secretToken: 'secret-1', tenantId: 'tenant-1' });
    });

    it('returns null when the tenant has no link', async () => {
        mockFindFirst.mockResolvedValue(null);
        expect(await repo.getLinkForTenant('tenant-1')).toBeNull();
    });

    it('wraps a DB failure in a descriptive error', async () => {
        mockFindFirst.mockRejectedValue(new Error('timeout'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.getLinkForTenant('tenant-1')).rejects.toThrow('Failed to get Telegram bot link: timeout');
        consoleSpy.mockRestore();
    });

    it('stringifies a non-Error throw in the wrapped message', async () => {
        mockFindFirst.mockRejectedValue('raw failure');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.getLinkForTenant('tenant-1')).rejects.toThrow('Failed to get Telegram bot link: raw failure');
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
        await expect(repo.deleteLinkForTenant('tenant-1')).rejects.toThrow('Failed to unlink Telegram bot: locked');
        consoleSpy.mockRestore();
    });

    it('stringifies a non-Error throw in the wrapped message', async () => {
        mockDeleteMany.mockRejectedValue('raw failure');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(repo.deleteLinkForTenant('tenant-1')).rejects.toThrow('Failed to unlink Telegram bot: raw failure');
        consoleSpy.mockRestore();
    });
});

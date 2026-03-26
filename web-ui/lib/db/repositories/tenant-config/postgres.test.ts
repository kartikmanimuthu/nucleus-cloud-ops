import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantConfigPostgresRepository } from './postgres';

// Mock the Prisma client module
vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
}));

import { getPrismaClient } from '@/lib/db/pg-config';

describe('TenantConfigPostgresRepository', () => {
    let repo: TenantConfigPostgresRepository;
    let mockTenantConfig: {
        findUnique: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
        deleteMany: ReturnType<typeof vi.fn>;
        findMany: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        mockTenantConfig = {
            findUnique: vi.fn(),
            upsert: vi.fn(),
            deleteMany: vi.fn(),
            findMany: vi.fn(),
        };
        vi.mocked(getPrismaClient).mockReturnValue({
            tenantConfig: mockTenantConfig,
        } as never);
        repo = new TenantConfigPostgresRepository();
    });

    describe('getConfig', () => {
        it('returns data when record found', async () => {
            mockTenantConfig.findUnique.mockResolvedValueOnce({
                data: { theme: 'dark' },
                configKey: 'theme',
                tenantId: 'tenant-1',
            });
            const result = await repo.getConfig<{ theme: string }>('theme', 'tenant-1');
            expect(result).toEqual({ theme: 'dark' });
        });

        it('returns null when record not found', async () => {
            mockTenantConfig.findUnique.mockResolvedValueOnce(null);
            const result = await repo.getConfig('missing', 'tenant-1');
            expect(result).toBeNull();
        });

        it('queries by compound unique key tenantId_configKey', async () => {
            mockTenantConfig.findUnique.mockResolvedValueOnce(null);
            await repo.getConfig('theme', 'tenant-1');
            expect(mockTenantConfig.findUnique).toHaveBeenCalledWith({
                where: { tenantId_configKey: { tenantId: 'tenant-1', configKey: 'theme' } },
            });
        });
    });

    describe('saveConfig', () => {
        it('calls upsert with correct create and update blocks', async () => {
            mockTenantConfig.upsert.mockResolvedValueOnce({});
            await repo.saveConfig('theme', { theme: 'dark' }, 'tenant-1');
            expect(mockTenantConfig.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tenantId_configKey: { tenantId: 'tenant-1', configKey: 'theme' } },
                    create: expect.objectContaining({ tenantId: 'tenant-1', configKey: 'theme' }),
                    update: expect.objectContaining({ data: { theme: 'dark' } }),
                })
            );
        });

        it('defaults updatedBy to system', async () => {
            mockTenantConfig.upsert.mockResolvedValueOnce({});
            await repo.saveConfig('theme', {}, 'tenant-1');
            expect(mockTenantConfig.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({ updatedBy: 'system' }),
                })
            );
        });
    });

    describe('deleteConfig', () => {
        it('calls deleteMany with tenantId and configKey', async () => {
            mockTenantConfig.deleteMany.mockResolvedValueOnce({ count: 1 });
            await repo.deleteConfig('theme', 'tenant-1');
            expect(mockTenantConfig.deleteMany).toHaveBeenCalledWith({
                where: { tenantId: 'tenant-1', configKey: 'theme' },
            });
        });
    });

    describe('listConfigs', () => {
        it('maps updatedAt to ISO string', async () => {
            const now = new Date('2025-01-01T00:00:00.000Z');
            mockTenantConfig.findMany.mockResolvedValueOnce([
                { configKey: 'theme', updatedAt: now },
            ]);
            const result = await repo.listConfigs('tenant-1');
            expect(result).toEqual([{ configKey: 'theme', updatedAt: '2025-01-01T00:00:00.000Z' }]);
        });

        it('queries only records for the given tenantId', async () => {
            mockTenantConfig.findMany.mockResolvedValueOnce([]);
            await repo.listConfigs('tenant-1');
            expect(mockTenantConfig.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: { tenantId: 'tenant-1' } })
            );
        });
    });
});

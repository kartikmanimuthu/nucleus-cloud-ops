import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: vi.fn(), saveConfig: vi.fn().mockResolvedValue(undefined) },
}));

const mockPrisma = {
    tenant: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
};
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn(() => mockPrisma) }));

import { TenantConfigService } from '@/lib/tenant-config-service';
import { TenantSettingsService } from '@/lib/tenant-settings-service';

describe('TenantSettingsService.getSettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPrisma.tenant.update.mockResolvedValue(undefined);
        vi.mocked(TenantConfigService.saveConfig).mockResolvedValue(undefined as any);
    });

    it('returns the tenant name/slug and stored timezone/notifications', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue({ name: 'Acme', slug: 'acme' });
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            timezone: 'Asia/Kolkata',
            notifications: { scheduleExecutions: false, memberInvites: true, systemAlerts: false },
        });

        const result = await TenantSettingsService.getSettings('tenant-1');

        expect(result).toEqual({
            name: 'Acme', slug: 'acme', timezone: 'Asia/Kolkata',
            notifications: { scheduleExecutions: false, memberInvites: true, systemAlerts: false },
        });
        expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
            where: { id: 'tenant-1' }, select: { name: true, slug: true },
        });
    });

    it('defaults to empty name/null slug and default settings when nothing is configured', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(null);
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);

        const result = await TenantSettingsService.getSettings('tenant-1');

        expect(result).toEqual({
            name: '', slug: null, timezone: 'UTC',
            notifications: { scheduleExecutions: true, memberInvites: true, systemAlerts: true },
        });
    });
});

describe('TenantSettingsService.updateSettings', () => {
    it('updates the tenant name and saves timezone/notifications to TenantConfig', async () => {
        await TenantSettingsService.updateSettings(
            'tenant-1',
            { name: 'New Name', timezone: 'UTC', notifications: { scheduleExecutions: true, memberInvites: false, systemAlerts: true } },
            'user-1',
        );

        expect(mockPrisma.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' }, data: { name: 'New Name' },
        });
        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'org_settings',
            { timezone: 'UTC', notifications: { scheduleExecutions: true, memberInvites: false, systemAlerts: true } },
            'tenant-1',
            'user-1',
        );
    });
});

describe('TenantSettingsService.getLogo / saveLogo', () => {
    it('getLogo reads the org_logo config key', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ key: 's3-key', url: 'https://x/logo.png' });
        expect(await TenantSettingsService.getLogo('tenant-1')).toEqual({ key: 's3-key', url: 'https://x/logo.png' });
        expect(TenantConfigService.getConfig).toHaveBeenCalledWith('org_logo', 'tenant-1');
    });

    it('getLogo returns null when no logo is configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        expect(await TenantSettingsService.getLogo('tenant-1')).toBeNull();
    });

    it('saveLogo writes the org_logo config key with the updater', async () => {
        await TenantSettingsService.saveLogo('tenant-1', { key: 's3-key', url: 'https://x/logo.png' }, 'user-1');
        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'org_logo', { key: 's3-key', url: 'https://x/logo.png' }, 'tenant-1', 'user-1',
        );
    });
});

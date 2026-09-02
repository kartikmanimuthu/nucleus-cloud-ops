import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getRbacRepository: vi.fn() }));

import { getRbacRepository } from '@/lib/db/repository-factory';
import { getUserTenantRole, getUserAllRoles, assignUserRole, getTenantUsers } from './role-service';

const mockRepo = {
    getUserTenantRole: vi.fn(),
    getUserAllRoles: vi.fn(),
    assignUserRole: vi.fn(),
    getTenantUsers: vi.fn(),
};

describe('role-service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getRbacRepository).mockReturnValue(mockRepo as any);
    });

    it('getUserTenantRole delegates to the repository', async () => {
        mockRepo.getUserTenantRole.mockResolvedValue('Owner');
        expect(await getUserTenantRole('u1', 'tenant-1')).toBe('Owner');
        expect(mockRepo.getUserTenantRole).toHaveBeenCalledWith('u1', 'tenant-1');
    });

    it('getUserTenantRole returns null and swallows a repository error', async () => {
        mockRepo.getUserTenantRole.mockRejectedValue(new Error('DB down'));
        expect(await getUserTenantRole('u1', 'tenant-1')).toBeNull();
    });

    it('getUserAllRoles delegates to the repository', async () => {
        mockRepo.getUserAllRoles.mockResolvedValue([{ tenantId: 't1', role: 'Owner' }]);
        expect(await getUserAllRoles('u1')).toEqual([{ tenantId: 't1', role: 'Owner' }]);
    });

    it('getUserAllRoles returns an empty array and swallows a repository error', async () => {
        mockRepo.getUserAllRoles.mockRejectedValue(new Error('DB down'));
        expect(await getUserAllRoles('u1')).toEqual([]);
    });

    it('assignUserRole delegates to the repository and propagates errors', async () => {
        await assignUserRole('u1', 'a@b.co', 'tenant-1', 'Admin' as any, 'admin@b.co');
        expect(mockRepo.assignUserRole).toHaveBeenCalledWith('u1', 'a@b.co', 'tenant-1', 'Admin', 'admin@b.co');

        mockRepo.assignUserRole.mockRejectedValue(new Error('DB down'));
        await expect(assignUserRole('u1', 'a@b.co', 'tenant-1', 'Admin' as any, 'admin@b.co')).rejects.toThrow('DB down');
    });

    it('getTenantUsers delegates to the repository', async () => {
        mockRepo.getTenantUsers.mockResolvedValue([{ userId: 'u1' }]);
        expect(await getTenantUsers('tenant-1')).toEqual([{ userId: 'u1' }]);
    });

    it('getTenantUsers returns an empty array and swallows a repository error', async () => {
        mockRepo.getTenantUsers.mockRejectedValue(new Error('DB down'));
        expect(await getTenantUsers('tenant-1')).toEqual([]);
    });
});

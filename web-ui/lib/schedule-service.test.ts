import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the repository factory before importing ScheduleService
vi.mock('@/lib/db/repository-factory', () => ({
    getScheduleRepository: vi.fn(),
}));

// Mock AuditService
vi.mock('@/lib/audit-service', () => ({
    AuditService: {
        logUserAction: vi.fn().mockResolvedValue(undefined),
    },
}));

// Mock aws-config (DEFAULT_TENANT_ID removed — tenantId is now always explicit)
vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn(),
    APP_TABLE_NAME: 'test-table',
    AUDIT_TABLE_NAME: 'test-audit-table',
}));

import { getScheduleRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { ScheduleService, buildSchedulePK, buildScheduleSK } from './schedule-service';

const makeSchedule = (overrides: Record<string, unknown> = {}) => ({
    id: 'sched-1',
    name: 'Test Schedule',
    starttime: '08:00',
    endtime: '18:00',
    timezone: 'America/New_York',
    active: true,
    days: ['Monday', 'Tuesday', 'Wednesday'],
    accounts: ['acc-1'],
    resourceTypes: ['ec2'],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    createdBy: 'alice',
    updatedBy: 'alice',
    ...overrides,
});

describe('ScheduleService', () => {
    let mockRepo: {
        getSchedules: ReturnType<typeof vi.fn>;
        getSchedule: ReturnType<typeof vi.fn>;
        createSchedule: ReturnType<typeof vi.fn>;
        updateSchedule: ReturnType<typeof vi.fn>;
        deleteSchedule: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset env vars
        delete process.env.USE_PG_SCHEDULES;
        delete process.env.DUAL_WRITE_SCHEDULES;
        mockRepo = {
            getSchedules: vi.fn(),
            getSchedule: vi.fn(),
            createSchedule: vi.fn(),
            updateSchedule: vi.fn(),
            deleteSchedule: vi.fn(),
        };
        vi.mocked(getScheduleRepository).mockReturnValue(mockRepo as any);
    });

    describe('buildSchedulePK / buildScheduleSK', () => {
        it('builds correct PK format', () => {
            expect(buildSchedulePK('tenant-1', 'acc-1')).toBe('TENANT#tenant-1#ACCOUNT#acc-1');
        });

        it('builds correct SK format', () => {
            expect(buildScheduleSK('sched-1')).toBe('SCHEDULE#sched-1');
        });
    });

    describe('getSchedules', () => {
        it('delegates filters to repo.getSchedules with explicit tenantId', async () => {
            mockRepo.getSchedules.mockResolvedValue({ schedules: [makeSchedule()], total: 1 });

            const result = await ScheduleService.getSchedules({
                statusFilter: 'active',
                searchTerm: 'test',
                tenantId: 'test-tenant',
            });

            expect(mockRepo.getSchedules).toHaveBeenCalledWith(
                expect.objectContaining({
                    tenantId: 'test-tenant',
                    statusFilter: 'active',
                    searchTerm: 'test',
                })
            );
            expect(result.schedules).toHaveLength(1);
            expect(result.total).toBe(1);
        });

        it('passes custom tenantId when provided', async () => {
            mockRepo.getSchedules.mockResolvedValue({ schedules: [], total: 0 });

            await ScheduleService.getSchedules({ tenantId: 'custom-tenant' });

            const callArg = mockRepo.getSchedules.mock.calls[0][0];
            expect(callArg.tenantId).toBe('custom-tenant');
        });

        it('returns { schedules: [], total: 0 } on error', async () => {
            mockRepo.getSchedules.mockRejectedValue(new Error('DB error'));

            const result = await ScheduleService.getSchedules();

            expect(result).toEqual({ schedules: [], total: 0 });
        });

        it('passes pagination (page, limit) through to repo', async () => {
            mockRepo.getSchedules.mockResolvedValue({ schedules: [], total: 0 });

            await ScheduleService.getSchedules({ page: 3, limit: 25 });

            expect(mockRepo.getSchedules).toHaveBeenCalledWith(
                expect.objectContaining({ page: 3, limit: 25 })
            );
        });
    });

    describe('getSchedulesWithFilters', () => {
        it('maps active=true to statusFilter "active"', async () => {
            mockRepo.getSchedules.mockResolvedValue({ schedules: [makeSchedule()], total: 1 });

            const result = await ScheduleService.getSchedulesWithFilters(true, 'test');

            expect(mockRepo.getSchedules).toHaveBeenCalledWith(
                expect.objectContaining({ statusFilter: 'active', searchTerm: 'test' })
            );
            expect(result).toHaveLength(1);
        });

        it('maps active=false to statusFilter "inactive"', async () => {
            mockRepo.getSchedules.mockResolvedValue({ schedules: [], total: 0 });

            await ScheduleService.getSchedulesWithFilters(false);

            expect(mockRepo.getSchedules).toHaveBeenCalledWith(
                expect.objectContaining({ statusFilter: 'inactive' })
            );
        });

        it('maps active=undefined to statusFilter undefined', async () => {
            mockRepo.getSchedules.mockResolvedValue({ schedules: [], total: 0 });

            await ScheduleService.getSchedulesWithFilters(undefined);

            expect(mockRepo.getSchedules).toHaveBeenCalledWith(
                expect.objectContaining({ statusFilter: undefined })
            );
        });
    });

    describe('getSchedule', () => {
        it('returns schedule when found', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ name: 'Found' }));

            const result = await ScheduleService.getSchedule('sched-1');

            expect(result).not.toBeNull();
            expect(result!.name).toBe('Found');
            expect(mockRepo.getSchedule).toHaveBeenCalledWith('sched-1', undefined, undefined);
        });

        it('returns null when not found', async () => {
            mockRepo.getSchedule.mockResolvedValue(null);

            const result = await ScheduleService.getSchedule('sched-missing');

            expect(result).toBeNull();
        });

        it('returns null on error', async () => {
            mockRepo.getSchedule.mockRejectedValue(new Error('DB error'));

            const result = await ScheduleService.getSchedule('sched-1');

            expect(result).toBeNull();
        });
    });

    describe('createSchedule', () => {
        it('calls repo.createSchedule and returns result (default path)', async () => {
            const created = makeSchedule({ id: 'sched-new' });
            mockRepo.createSchedule.mockResolvedValue(created);

            const input = makeSchedule({ id: undefined });
            const result = await ScheduleService.createSchedule(input as any, 'test-tenant');

            expect(mockRepo.createSchedule).toHaveBeenCalledWith(input, 'test-tenant');
            expect(result.id).toBe('sched-new');
        });

        it('calls AuditService.logUserAction on success with correct metadata', async () => {
            mockRepo.createSchedule.mockResolvedValue(makeSchedule());

            await ScheduleService.createSchedule(makeSchedule() as any, 'test-tenant');

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Created Schedule',
                    resourceType: 'schedule',
                    status: 'success',
                    metadata: expect.objectContaining({
                        tenantId: 'test-tenant',
                        accountId: 'acc-1',
                        scheduleName: 'Test Schedule',
                    }),
                })
            );
        });

        it('calls AuditService.logUserAction with status "error" on failure', async () => {
            mockRepo.createSchedule.mockRejectedValue(new Error('Duplicate'));

            await expect(ScheduleService.createSchedule(makeSchedule() as any)).rejects.toThrow('Duplicate');

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Created Schedule',
                    status: 'error',
                    details: expect.stringContaining('Duplicate'),
                })
            );
        });

        it('re-throws error on failure', async () => {
            mockRepo.createSchedule.mockRejectedValue(new Error('Create failed'));

            await expect(ScheduleService.createSchedule(makeSchedule() as any)).rejects.toThrow('Create failed');
        });
    });

    describe('updateSchedule', () => {
        it('calls repo.updateSchedule and returns result', async () => {
            const updated = makeSchedule({ name: 'Updated' });
            mockRepo.updateSchedule.mockResolvedValue(updated);

            const result = await ScheduleService.updateSchedule('sched-1', { active: false });

            expect(mockRepo.updateSchedule).toHaveBeenCalledWith('sched-1', { active: false }, undefined, undefined);
            expect(result.name).toBe('Updated');
        });

        it('calls AuditService.logUserAction on success', async () => {
            mockRepo.updateSchedule.mockResolvedValue(makeSchedule());

            await ScheduleService.updateSchedule('sched-1', { active: false });

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Updated Schedule',
                    resourceType: 'schedule',
                    status: 'success',
                })
            );
        });

        it('re-throws error on failure', async () => {
            mockRepo.updateSchedule.mockRejectedValue(new Error('Update failed'));

            await expect(ScheduleService.updateSchedule('sched-1', {})).rejects.toThrow('Update failed');
        });
    });

    describe('deleteSchedule', () => {
        it('fetches schedule first, then calls repo.deleteSchedule', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule());
            mockRepo.deleteSchedule.mockResolvedValue(undefined);

            await ScheduleService.deleteSchedule('sched-1');

            expect(mockRepo.getSchedule).toHaveBeenCalledWith('sched-1', undefined, undefined);
            expect(mockRepo.deleteSchedule).toHaveBeenCalledWith('sched-1', undefined, undefined);
        });

        it('calls AuditService.logUserAction on success', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule());
            mockRepo.deleteSchedule.mockResolvedValue(undefined);

            await ScheduleService.deleteSchedule('sched-1', undefined, 'bob');

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Deleted Schedule',
                    resourceType: 'schedule',
                    user: 'bob',
                    status: 'success',
                })
            );
        });

        it('returns silently when schedule not found', async () => {
            mockRepo.getSchedule.mockResolvedValue(null);

            await ScheduleService.deleteSchedule('sched-missing');

            expect(mockRepo.deleteSchedule).not.toHaveBeenCalled();
            expect(AuditService.logUserAction).not.toHaveBeenCalled();
        });
    });

    describe('toggleScheduleStatus', () => {
        it('throws "Schedule not found" when getSchedule returns null', async () => {
            mockRepo.getSchedule.mockResolvedValue(null);

            await expect(ScheduleService.toggleScheduleStatus('sched-missing')).rejects.toThrow('Schedule not found');
        });

        it('flips active true to false via updateSchedule', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ active: true }));
            mockRepo.updateSchedule.mockResolvedValue(makeSchedule({ active: false }));

            await ScheduleService.toggleScheduleStatus('sched-1');

            expect(mockRepo.updateSchedule).toHaveBeenCalledWith(
                'sched-1',
                expect.objectContaining({ active: false }),
                undefined,
                'acc-1'
            );
        });

        it('flips active false to true via updateSchedule', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ active: false }));
            mockRepo.updateSchedule.mockResolvedValue(makeSchedule({ active: true }));

            await ScheduleService.toggleScheduleStatus('sched-1');

            expect(mockRepo.updateSchedule).toHaveBeenCalledWith(
                'sched-1',
                expect.objectContaining({ active: true }),
                undefined,
                'acc-1'
            );
        });
    });
});

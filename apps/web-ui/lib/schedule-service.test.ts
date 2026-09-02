import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the repository factory before importing ScheduleService
vi.mock('@/lib/db/repository-factory', () => ({
    getScheduleRepository: vi.fn(),
}));

// Mock AuditService
vi.mock('@/lib/audit-service', () => ({
    AuditService: {
        logUserAction: vi.fn().mockResolvedValue(undefined),
        logResourceAction: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('@/lib/boss-client', () => ({ getBoss: vi.fn() }));

// `env.USE_PG_SCHEDULES` is read at call time (not import time), so mutating this mocked
// object's property between tests is enough to flip the usePg branch — no resetModules needed.
vi.mock('@/env', () => ({ env: { USE_PG_SCHEDULES: 'false' } }));

// NOTE: every `usePg` branch in schedule-service.ts loads its Postgres repo via a call-time
// `require('@/lib/db/repositories/schedule/postgres')` (the `@/` tsconfig alias). Under Next's
// real webpack build this resolves fine (webpack statically rewrites aliased `require()` calls
// at build time, same as `import`). Under vitest/vite-node, `vi.mock()` only intercepts vite's
// own ESM-transformed `import` graph — a raw `require()` falls through to Node's real
// `Module._resolveFilename`, which has no notion of the tsconfig alias, so it throws
// `MODULE_NOT_FOUND` regardless of any vi.mock() targeting that specifier. Confirmed by trying
// (see git history) — this is the same class of harness limitation already documented for
// lib/db/repository-factory.ts, just triggered by an alias-path require instead of a
// same-directory relative one. The `usePg=true` branches are therefore exercised only via their
// surrounding try/catch behavior (the require failure itself), not via true PG delegation.

import { getScheduleRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import { env } from '@/env';
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
        (env as { USE_PG_SCHEDULES: string }).USE_PG_SCHEDULES = 'false';
        mockRepo = {
            getSchedules: vi.fn(),
            getSchedule: vi.fn(),
            createSchedule: vi.fn(),
            updateSchedule: vi.fn(),
            deleteSchedule: vi.fn(),
        };
        vi.mocked(getScheduleRepository).mockReturnValue(mockRepo as any);
        vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockResolvedValue('job-1') } as any);
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
                    resourceType: 'Schedule',
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

        it('exercises the usePg branch when USE_PG_SCHEDULES=true (PG delegation itself untestable under vite-node — see NOTE above)', async () => {
            (env as { USE_PG_SCHEDULES: string }).USE_PG_SCHEDULES = 'true';

            await expect(ScheduleService.createSchedule(makeSchedule() as any, 'test-tenant')).rejects.toThrow();

            expect(mockRepo.createSchedule).not.toHaveBeenCalled();
            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'Created Schedule', status: 'error' })
            );
        });

        it('defaults the audit "user" to "system" when createdBy is not set', async () => {
            mockRepo.createSchedule.mockResolvedValue(makeSchedule());

            await ScheduleService.createSchedule(makeSchedule({ createdBy: undefined }) as any, 'test-tenant');

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'Created Schedule', status: 'success', user: 'system' })
            );
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
                    resourceType: 'Schedule',
                    status: 'success',
                })
            );
        });

        it('re-throws error on failure', async () => {
            mockRepo.updateSchedule.mockRejectedValue(new Error('Update failed'));

            await expect(ScheduleService.updateSchedule('sched-1', {})).rejects.toThrow('Update failed');
        });

        it('skips the audit log when skipAudit=true', async () => {
            mockRepo.updateSchedule.mockResolvedValue(makeSchedule());

            await ScheduleService.updateSchedule('sched-1', { active: false }, undefined, undefined, true);

            expect(AuditService.logUserAction).not.toHaveBeenCalled();
        });

        it('exercises the usePg branch when USE_PG_SCHEDULES=true (PG delegation itself untestable under vite-node — see NOTE above)', async () => {
            (env as { USE_PG_SCHEDULES: string }).USE_PG_SCHEDULES = 'true';
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await expect(ScheduleService.updateSchedule('sched-1', { active: false })).rejects.toThrow();

            expect(mockRepo.updateSchedule).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
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
                    resourceType: 'Schedule',
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

        it('swallows errors silently (fire-and-forget delete)', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule());
            mockRepo.deleteSchedule.mockRejectedValue(new Error('Delete failed'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await expect(ScheduleService.deleteSchedule('sched-1')).resolves.toBeUndefined();

            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('exercises the usePg branch when USE_PG_SCHEDULES=true and silently swallows the failure (PG delegation itself untestable under vite-node — see NOTE above)', async () => {
            (env as { USE_PG_SCHEDULES: string }).USE_PG_SCHEDULES = 'true';
            mockRepo.getSchedule.mockResolvedValue(makeSchedule());
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await expect(ScheduleService.deleteSchedule('sched-1', 'acc-1', 'bob', 'test-tenant')).resolves.toBeUndefined();

            expect(mockRepo.deleteSchedule).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
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

        it('logs a "Toggled Schedule" audit event with before/after changeSet', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ active: true, name: 'Test Schedule' }));
            mockRepo.updateSchedule.mockResolvedValue(makeSchedule({ active: false }));

            await ScheduleService.toggleScheduleStatus('sched-1', undefined, 'carol');

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Toggled Schedule',
                    user: 'carol',
                    changeSet: { before: { active: true }, after: { active: false } },
                })
            );
        });

        it('exercises the usePg branch when USE_PG_SCHEDULES=true (PG delegation itself untestable under vite-node — see NOTE above)', async () => {
            (env as { USE_PG_SCHEDULES: string }).USE_PG_SCHEDULES = 'true';
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ active: true }));

            await expect(ScheduleService.toggleScheduleStatus('sched-1')).rejects.toThrow();

            expect(mockRepo.updateSchedule).not.toHaveBeenCalled();
        });
    });

    describe('setScheduleActive', () => {
        it('throws "Schedule not found" when getSchedule returns null', async () => {
            mockRepo.getSchedule.mockResolvedValue(null);

            await expect(ScheduleService.setScheduleActive('sched-missing', true)).rejects.toThrow('Schedule not found');
        });

        it('returns the current schedule unchanged when already in the desired state (no-op)', async () => {
            const current = makeSchedule({ active: true });
            mockRepo.getSchedule.mockResolvedValue(current);

            const result = await ScheduleService.setScheduleActive('sched-1', true);

            expect(result).toBe(current);
            expect(mockRepo.updateSchedule).not.toHaveBeenCalled();
            expect(AuditService.logUserAction).not.toHaveBeenCalled();
        });

        it('sets active=true via updateSchedule when currently inactive', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ active: false }));
            mockRepo.updateSchedule.mockResolvedValue(makeSchedule({ active: true }));

            const result = await ScheduleService.setScheduleActive('sched-1', true, 'dave');

            expect(mockRepo.updateSchedule).toHaveBeenCalledWith(
                'sched-1',
                expect.objectContaining({ active: true, updatedBy: 'dave' }),
                undefined,
                'acc-1'
            );
            expect(result.active).toBe(true);
        });

        it('sets active=false via updateSchedule when currently active', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ active: true }));
            mockRepo.updateSchedule.mockResolvedValue(makeSchedule({ active: false }));

            await ScheduleService.setScheduleActive('sched-1', false);

            expect(mockRepo.updateSchedule).toHaveBeenCalledWith(
                'sched-1',
                expect.objectContaining({ active: false }),
                undefined,
                'acc-1'
            );
        });

        it('logs "Activated Schedule" / "Deactivated Schedule" audit events accordingly', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ active: false, name: 'Test Schedule' }));
            mockRepo.updateSchedule.mockResolvedValue(makeSchedule({ active: true }));

            await ScheduleService.setScheduleActive('sched-1', true, 'erin', 'test-tenant');

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Activated Schedule',
                    user: 'erin',
                    tenantId: 'test-tenant',
                    changeSet: { before: { active: false }, after: { active: true } },
                })
            );
        });

        it('exercises the usePg branch when USE_PG_SCHEDULES=true (PG delegation itself untestable under vite-node — see NOTE above)', async () => {
            (env as { USE_PG_SCHEDULES: string }).USE_PG_SCHEDULES = 'true';
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ active: false }));

            await expect(ScheduleService.setScheduleActive('sched-1', true)).rejects.toThrow();

            expect(mockRepo.updateSchedule).not.toHaveBeenCalled();
        });

        it("uses the explicit accountId override instead of the schedule's first account", async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ active: false, accounts: ['acc-1'] }));
            mockRepo.updateSchedule.mockResolvedValue(makeSchedule({ active: true }));

            await ScheduleService.setScheduleActive('sched-1', true, 'system', undefined, 'acc-override');

            expect(mockRepo.updateSchedule).toHaveBeenCalledWith(
                'sched-1',
                expect.objectContaining({ active: true }),
                undefined,
                'acc-override'
            );
        });
    });

    describe('executeSchedule', () => {
        it('throws "Schedule not found" when getSchedule returns null', async () => {
            mockRepo.getSchedule.mockResolvedValue(null);

            await expect(ScheduleService.executeSchedule('sched-missing')).rejects.toThrow('Schedule not found');
        });

        it('enqueues a scheduler-scan job via pg-boss with a per-tenant+schedule singletonKey', async () => {
            const schedule = makeSchedule({ id: 'sched-1', name: 'Nightly', executionCount: 2 });
            mockRepo.getSchedule.mockResolvedValue(schedule);
            const mockSend = vi.fn().mockResolvedValue('job-123');
            vi.mocked(getBoss).mockResolvedValue({ send: mockSend } as any);
            mockRepo.updateSchedule.mockResolvedValue(schedule);

            await ScheduleService.executeSchedule('sched-1', 'frank', 'test-tenant');

            expect(mockSend).toHaveBeenCalledWith(
                'scheduler-scan',
                expect.objectContaining({
                    scheduleId: 'sched-1',
                    scheduleName: 'Nightly',
                    triggeredBy: 'web-ui',
                    userEmail: 'frank',
                    tenantId: 'test-tenant',
                }),
                expect.objectContaining({ priority: 10, singletonKey: 'manual:test-tenant:sched-1' })
            );
        });

        it('defaults userEmail to "unknown-web-user" when executedBy is falsy', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule());
            const mockSend = vi.fn().mockResolvedValue('job-1');
            vi.mocked(getBoss).mockResolvedValue({ send: mockSend } as any);
            mockRepo.updateSchedule.mockResolvedValue(makeSchedule());

            await ScheduleService.executeSchedule('sched-1', '');

            expect(mockSend).toHaveBeenCalledWith(
                'scheduler-scan',
                expect.objectContaining({ userEmail: 'unknown-web-user' }),
                expect.anything()
            );
        });

        it('logs (but does not throw) when the job is deduplicated (jobId null)', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule());
            vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockResolvedValue(null) } as any);
            mockRepo.updateSchedule.mockResolvedValue(makeSchedule());
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            await expect(ScheduleService.executeSchedule('sched-1')).resolves.toEqual(
                expect.objectContaining({ executionTime: expect.any(String) })
            );

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('deduplicated'));
            consoleSpy.mockRestore();
        });

        it('logs an error audit event and re-throws when enqueue fails', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ id: 'sched-1', name: 'Nightly' }));
            vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockRejectedValue(new Error('queue down')) } as any);

            await expect(ScheduleService.executeSchedule('sched-1', 'frank', 'test-tenant')).rejects.toThrow('queue down');

            expect(AuditService.logResourceAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Execute Schedule',
                    status: 'error',
                    severity: 'high',
                    details: expect.stringContaining('queue down'),
                    tenantId: 'test-tenant',
                })
            );
            expect(mockRepo.updateSchedule).not.toHaveBeenCalled();
        });

        it('stringifies a non-Error enqueue rejection and defaults user to "unknown-web-user"', async () => {
            mockRepo.getSchedule.mockResolvedValue(makeSchedule({ id: 'sched-1', name: 'Nightly' }));
            vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockRejectedValue('queue offline') } as any);

            await expect(ScheduleService.executeSchedule('sched-1', '')).rejects.toBe('queue offline');

            expect(AuditService.logResourceAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 'error',
                    details: expect.stringContaining('queue offline'),
                    user: 'unknown-web-user',
                })
            );
        });

        it('updates schedule metadata (skipAudit) then logs a success audit event on successful enqueue', async () => {
            const schedule = makeSchedule({ id: 'sched-1', name: 'Nightly', executionCount: 4, accounts: ['acc-9'] });
            mockRepo.getSchedule.mockResolvedValue(schedule);
            vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockResolvedValue('job-1') } as any);
            mockRepo.updateSchedule.mockResolvedValue(schedule);

            const result = await ScheduleService.executeSchedule('sched-1', 'frank', 'test-tenant');

            expect(mockRepo.updateSchedule).toHaveBeenCalledWith(
                'sched-1',
                expect.objectContaining({ lastExecution: expect.any(String), executionCount: 5, active: true }),
                'test-tenant',
                'acc-9'
            );
            // skipAudit=true on the internal updateSchedule call means the generic
            // "Updated Schedule" event must NOT fire — only the "Execute Schedule" one below.
            expect(AuditService.logUserAction).not.toHaveBeenCalled();
            expect(AuditService.logResourceAction).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'Execute Schedule', status: 'success', tenantId: 'test-tenant' })
            );
            expect(result).toEqual({ executionTime: expect.any(String) });
        });

        it('falls back to "unknown" account when the schedule has no accounts', async () => {
            const schedule = makeSchedule({ id: 'sched-1', accounts: [] });
            mockRepo.getSchedule.mockResolvedValue(schedule);
            vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockResolvedValue('job-1') } as any);
            mockRepo.updateSchedule.mockResolvedValue(schedule);

            await ScheduleService.executeSchedule('sched-1');

            expect(mockRepo.updateSchedule).toHaveBeenCalledWith(
                'sched-1',
                expect.anything(),
                undefined,
                'unknown'
            );
        });
    });
});

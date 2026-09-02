import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getCapacityPlanningRepository: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/boss-client', () => ({ getBoss: vi.fn() }));

import { getCapacityPlanningRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import { CapacityPlanningService } from './capacity-planning-service';

const mockRepo = {
    getUtilizationSummary: vi.fn(), listBreachInstances: vi.fn(), getResourceDetail: vi.fn(), listRuns: vi.fn(),
};
const mockBoss = { send: vi.fn() };

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCapacityPlanningRepository).mockReturnValue(mockRepo as any);
    vi.mocked(getBoss).mockResolvedValue(mockBoss as any);
});

describe('clampToCompute (via getUtilizationSummary)', () => {
    it('defaults resourceType to ["ecs","asg"] when none is requested', async () => {
        mockRepo.getUtilizationSummary.mockResolvedValue({ resources: [], total: 0 });
        await CapacityPlanningService.getUtilizationSummary({ tenantId: 't1' } as any, 70);
        expect(mockRepo.getUtilizationSummary).toHaveBeenCalledWith(
            expect.objectContaining({ resourceType: ['ecs', 'asg'] }), 70,
        );
    });

    it('passes through a single allowed resourceType', async () => {
        mockRepo.getUtilizationSummary.mockResolvedValue({ resources: [], total: 0 });
        await CapacityPlanningService.getUtilizationSummary({ tenantId: 't1', resourceType: 'ecs' } as any);
        expect(mockRepo.getUtilizationSummary).toHaveBeenCalledWith(
            expect.objectContaining({ resourceType: ['ecs'] }), undefined,
        );
    });

    it('strips a disallowed resourceType and falls back to the full compute set', async () => {
        mockRepo.listBreachInstances.mockResolvedValue({ instances: [], total: 0 });
        await CapacityPlanningService.listBreachInstances({ tenantId: 't1', resourceType: 'ec2' as any });
        expect(mockRepo.listBreachInstances).toHaveBeenCalledWith(
            expect.objectContaining({ resourceType: ['ecs', 'asg'] }), undefined,
        );
    });

    it('keeps only the allowed entries from a mixed resourceType array', async () => {
        mockRepo.getResourceDetail.mockResolvedValue(null);
        await CapacityPlanningService.getResourceDetail({ tenantId: 't1', resourceType: ['ec2', 'asg'] as any }, 'res1');
        expect(mockRepo.getResourceDetail).toHaveBeenCalledWith(
            expect.objectContaining({ resourceType: ['asg'] }), 'res1',
        );
    });
});

describe('listRuns', () => {
    it('delegates directly to the repository', async () => {
        mockRepo.listRuns.mockResolvedValue({ runs: [], total: 0 });
        await CapacityPlanningService.listRuns('t1', 2, 25);
        expect(mockRepo.listRuns).toHaveBeenCalledWith('t1', 2, 25);
    });
});

describe('triggerScan', () => {
    it('enqueues a scan and logs an audit event when not already running', async () => {
        mockBoss.send.mockResolvedValue('job-1');
        const result = await CapacityPlanningService.triggerScan('t1', 'a@b.co');

        expect(mockBoss.send).toHaveBeenCalledWith(
            'capacity-planning-scan', { tenantId: 't1', trigger: 'manual' },
            expect.objectContaining({ singletonKey: 'tenant:t1' }),
        );
        expect(result).toEqual({ alreadyRunning: false });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'capacity_planning.scan.triggered', resourceId: 'job-1' })
        );
    });

    it('reports alreadyRunning when the singleton key rejects the job', async () => {
        mockBoss.send.mockResolvedValue(null);
        const result = await CapacityPlanningService.triggerScan('t1', 'a@b.co');
        expect(result).toEqual({ alreadyRunning: true });
    });

    it('falls back to "system" as the user when triggeredBy is blank', async () => {
        mockBoss.send.mockResolvedValue('job-1');
        await CapacityPlanningService.triggerScan('t1', '');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ user: 'system' }));
    });
});

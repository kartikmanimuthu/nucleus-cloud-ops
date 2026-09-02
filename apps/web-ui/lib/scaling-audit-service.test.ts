import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getScalingAuditRepository: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/boss-client', () => ({ getBoss: vi.fn() }));

import { getScalingAuditRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import { ScalingAuditService } from './scaling-audit-service';

const mockRepo = {
    listEvents: vi.fn(), getEvent: vi.fn(), getSummary: vi.fn(), getFacets: vi.fn(),
    listRuns: vi.fn(), getWatermarkGaps: vi.fn(), listPolicySnapshots: vi.fn(),
    listAllEvents: vi.fn(), getLatestSeal: vi.fn(),
};
const mockBoss = { send: vi.fn() };

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getScalingAuditRepository).mockReturnValue(mockRepo as any);
    vi.mocked(getBoss).mockResolvedValue(mockBoss as any);
});

describe('read delegation', () => {
    it('delegates listEvents/getEvent/getSummary/getFacets/listRuns/getWatermarkGaps/listPolicySnapshots to the repository', async () => {
        mockRepo.listEvents.mockResolvedValue({ events: [], total: 0 });
        mockRepo.getEvent.mockResolvedValue({ id: 'e1' });
        mockRepo.getSummary.mockResolvedValue({});
        mockRepo.getFacets.mockResolvedValue({});
        mockRepo.listRuns.mockResolvedValue({ runs: [], total: 0 });
        mockRepo.getWatermarkGaps.mockResolvedValue([]);
        mockRepo.listPolicySnapshots.mockResolvedValue([]);

        await ScalingAuditService.listEvents({ tenantId: 't1' } as any);
        await ScalingAuditService.getEvent('e1', 't1');
        await ScalingAuditService.getSummary('t1');
        await ScalingAuditService.getFacets('t1');
        await ScalingAuditService.listRuns('t1', 1, 10);
        await ScalingAuditService.getWatermarkGaps('t1');
        await ScalingAuditService.listPolicySnapshots('t1', 'acc1', 'us-east-1', 'res1');

        expect(mockRepo.getEvent).toHaveBeenCalledWith('e1', 't1');
        expect(mockRepo.listRuns).toHaveBeenCalledWith('t1', 1, 10);
        expect(mockRepo.listPolicySnapshots).toHaveBeenCalledWith('t1', 'acc1', 'us-east-1', 'res1');
    });
});

describe('getExportData', () => {
    it('returns events, gaps, and seal without truncation when under the cap', async () => {
        mockRepo.listAllEvents.mockResolvedValue([{ id: 'e1' }]);
        mockRepo.getWatermarkGaps.mockResolvedValue([{ gap: 1 }]);
        mockRepo.getLatestSeal.mockResolvedValue({ day: '2026-02-01', seal: 'abc', rowCount: 1 });

        const result = await ScalingAuditService.getExportData({ tenantId: 't1' } as any);

        expect(mockRepo.listAllEvents).toHaveBeenCalledWith({ tenantId: 't1' }, 50_001);
        expect(result).toEqual({
            events: [{ id: 'e1' }], gaps: [{ gap: 1 }],
            seal: { day: '2026-02-01', seal: 'abc', rowCount: 1 }, truncated: false,
        });
    });

    it('truncates to MAX_EXPORT_ROWS and reports truncated:true when the cap is exceeded', async () => {
        const events = Array.from({ length: 50_001 }, (_, i) => ({ id: `e${i}` }));
        mockRepo.listAllEvents.mockResolvedValue(events);
        mockRepo.getWatermarkGaps.mockResolvedValue([]);
        mockRepo.getLatestSeal.mockResolvedValue(null);

        const result = await ScalingAuditService.getExportData({ tenantId: 't1' } as any);

        expect(result.events).toHaveLength(50_000);
        expect(result.truncated).toBe(true);
        expect(result.seal).toBeNull();
    });
});

describe('triggerScan', () => {
    it('enqueues a scan and logs a low-severity audit event when not already running', async () => {
        mockBoss.send.mockResolvedValue('job-1');

        const result = await ScalingAuditService.triggerScan('t1', 'a@b.co');

        expect(mockBoss.send).toHaveBeenCalledWith(
            'scaling-audit-scan', { tenantId: 't1', trigger: 'manual' },
            expect.objectContaining({ singletonKey: 'tenant:t1' }),
        );
        expect(result).toEqual({ alreadyRunning: false });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'scaling_audit.scan.triggered', resourceId: 'job-1' })
        );
    });

    it('reports alreadyRunning when the singleton key rejects the job', async () => {
        mockBoss.send.mockResolvedValue(null);

        const result = await ScalingAuditService.triggerScan('t1', 'a@b.co');

        expect(result).toEqual({ alreadyRunning: true });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ resourceId: 'already-running', details: expect.stringContaining('already queued') })
        );
    });

    it('falls back to "system" as the user when triggeredBy is blank', async () => {
        mockBoss.send.mockResolvedValue('job-1');
        await ScalingAuditService.triggerScan('t1', '');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ user: 'system' }));
    });
});

describe('logExport', () => {
    it('logs an export audit event with format, row count, and seal', async () => {
        await ScalingAuditService.logExport('t1', 'a@b.co', 'xlsx', { status: 'active' }, 42, 'seal-abc');

        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'scaling_audit.export.completed', resourceId: 'seal-abc',
            details: expect.stringContaining('42 row(s) as XLSX'),
        }));
    });

    it('uses "no-seal" as the resourceId when no seal exists', async () => {
        await ScalingAuditService.logExport('t1', 'a@b.co', 'pdf', {}, 0, null);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'no-seal' }));
    });
});

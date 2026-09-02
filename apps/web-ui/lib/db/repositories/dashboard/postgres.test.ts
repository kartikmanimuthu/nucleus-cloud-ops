import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));

import { getTenantClient } from '@/lib/db/pg-config';
import { DashboardPostgresRepository } from './postgres';

const repo = new DashboardPostgresRepository();

function makeDb(overrides: Record<string, any> = {}) {
    const empty = () => vi.fn().mockResolvedValue([]);
    const zero = () => vi.fn().mockResolvedValue(0);
    return {
        scheduleExecution: { findMany: empty() },
        targetedResource: { count: zero() },
        account: { count: zero(), findMany: empty() },
        agentOpsRun: { count: zero(), findMany: empty() },
        auditLog: { count: zero(), findMany: empty() },
        schedule: { findMany: empty() },
        agentOpsEvent: { findMany: empty() },
        scheduledTask: { count: zero() },
        chatSession: { count: zero() },
        chatMessage: { count: zero() },
        inventoryResource: { findMany: empty() },
        inventorySyncStatus: { findFirst: vi.fn().mockResolvedValue(null) },
        knowledgeBase: { findMany: empty() },
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-10T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('getKpiStats', () => {
    it('computes cards from executions, accounts, agent runs, and audit logs', async () => {
        const db = makeDb({
            scheduleExecution: {
                findMany: vi.fn()
                    .mockResolvedValueOnce([
                        { status: 'success', resourcesStopped: 3, executionTime: new Date('2026-02-09T12:00:00Z') },
                        { status: 'failed', resourcesStopped: 1, executionTime: new Date('2026-02-09T18:00:00Z') },
                    ])
                    .mockResolvedValueOnce([{ status: 'success', resourcesStopped: 2 }]),
            },
            targetedResource: { count: vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(8) },
            account: { count: vi.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(4) },
            agentOpsRun: { count: vi.fn().mockResolvedValueOnce(20).mockResolvedValueOnce(15) },
            auditLog: { count: vi.fn().mockResolvedValueOnce(100).mockResolvedValueOnce(90).mockResolvedValueOnce(2) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getKpiStats('tenant-1', '7d');

        expect(getTenantClient).toHaveBeenCalledWith('tenant-1');
        const savings = result.cards.find(c => c.id === 'savings')!;
        expect(savings.value).toBeCloseTo(0.4); // 4 stopped * 0.10
        const successRate = result.cards.find(c => c.id === 'success-rate')!;
        expect(successRate.value).toBe(50); // 1/2 succeeded
        const auditEvents = result.cards.find(c => c.id === 'audit-events')!;
        expect(auditEvents.formattedValue).toContain('2 critical');
    });

    it('handles zero executions without dividing by zero', async () => {
        const db = makeDb();
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getKpiStats('tenant-1', '24h');
        const successRate = result.cards.find(c => c.id === 'success-rate')!;
        expect(successRate.value).toBe(0);
        const auditEvents = result.cards.find(c => c.id === 'audit-events')!;
        expect(auditEvents.formattedValue).not.toContain('critical');
    });
});

describe('getCostMetrics', () => {
    it('aggregates trend and per-account savings, sorted descending', async () => {
        const db = makeDb({
            scheduleExecution: {
                findMany: vi.fn().mockResolvedValue([
                    { scheduleId: 's1', accountId: 'a1', resourcesStopped: 5, executionTime: new Date('2026-02-09T00:00:00Z') },
                    { scheduleId: 's2', accountId: 'a2', resourcesStopped: 10, executionTime: new Date('2026-02-08T00:00:00Z') },
                ]),
            },
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'a1', name: 'Account One' }, { accountId: 'a2', name: 'Account Two' }]) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getCostMetrics('tenant-1', '7d');

        expect(result.byAccount[0].accountId).toBe('a2'); // higher savings first
        expect(result.byAccount[0].accountName).toBe('Account Two');
        expect(result.summary.totalSavings).toBeCloseTo(1.5);
        expect(result.summary.topAccount).toBe('Account Two');
        expect(result.trend.length).toBeGreaterThan(0);
    });

    it('falls back to "N/A" and zero savings with no executions', async () => {
        const db = makeDb();
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getCostMetrics('tenant-1', '30d');
        expect(result.summary.topAccount).toBe('N/A');
        expect(result.summary.totalSavings).toBe(0);
    });
});

describe('getOperationsMetrics', () => {
    it('classifies executions into success/partial/full failure and builds a timeline', async () => {
        const db = makeDb({
            account: { findMany: vi.fn().mockResolvedValue([{ id: 'acc1', name: 'A', connectionStatus: 'connected', lastSyncedAt: new Date() }]) },
            scheduleExecution: {
                findMany: vi.fn().mockResolvedValue([
                    { scheduleId: 's1', status: 'success', resourcesStarted: 2, resourcesStopped: 0, resourcesFailed: 0, duration: 1.5, executionTime: new Date('2026-02-09T00:00:00Z') },
                    { scheduleId: 's1', status: 'failed', resourcesStarted: 1, resourcesStopped: 0, resourcesFailed: 1, duration: 0.5, executionTime: new Date('2026-02-09T01:00:00Z') },
                    { scheduleId: 's2', status: 'failed', resourcesStarted: 0, resourcesStopped: 0, resourcesFailed: 3, duration: 2, executionTime: new Date('2026-02-08T00:00:00Z') },
                ]),
            },
            schedule: { findMany: vi.fn().mockResolvedValue([{ scheduleId: 's1', name: 'Sched One' }, { scheduleId: 's2', name: 'Sched Two' }]) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getOperationsMetrics('tenant-1', '7d');

        const s1 = result.executionBySchedule.find(s => s.scheduleId === 's1')!;
        expect(s1).toEqual(expect.objectContaining({ scheduleName: 'Sched One', success: 1, partialFail: 1, fullFail: 0 }));
        const s2 = result.executionBySchedule.find(s => s.scheduleId === 's2')!;
        expect(s2.fullFail).toBe(1);
        expect(result.summary.totalExecutions).toBe(3);
        expect(result.summary.avgDurationMs).toBe(Math.round(((1.5 + 0.5 + 2) / 3) * 1000));
    });

    it('handles no accounts or executions', async () => {
        const db = makeDb();
        vi.mocked(getTenantClient).mockReturnValue(db as any);
        const result = await repo.getOperationsMetrics('tenant-1', '24h');
        expect(result.accounts).toEqual([]);
        expect(result.summary.successRate).toBe(0);
        expect(result.summary.avgDurationMs).toBe(0);
    });
});

describe('getAgentMetrics', () => {
    it('summarizes runs by source/status and top tool usage', async () => {
        const db = makeDb({
            agentOpsRun: {
                findMany: vi.fn().mockResolvedValue([
                    { source: 'slack', status: 'completed', durationMs: 1000, createdAt: new Date('2026-02-09T00:00:00Z') },
                    { source: 'slack', status: 'failed', durationMs: 500, createdAt: new Date('2026-02-09T01:00:00Z') },
                    { source: 'api', status: 'in_progress', durationMs: null, createdAt: new Date('2026-02-08T00:00:00Z') },
                ]),
                count: vi.fn(),
            },
            agentOpsEvent: { findMany: vi.fn().mockResolvedValue([{ toolName: 'stop_ec2' }, { toolName: 'stop_ec2' }, { toolName: null }]) },
            scheduledTask: { count: vi.fn().mockResolvedValue(3) },
            chatSession: { count: vi.fn().mockResolvedValue(5) },
            chatMessage: { count: vi.fn().mockResolvedValue(50) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getAgentMetrics('tenant-1', '7d');

        expect(result.bySource).toEqual(expect.arrayContaining([{ source: 'slack', count: 2 }, { source: 'api', count: 1 }]));
        expect(result.topTools).toEqual([{ toolName: 'stop_ec2', count: 2 }]);
        expect(result.summary.totalRuns).toBe(3);
        expect(result.summary.successRate).toBe(33); // 1/3 completed
        expect(result.summary.avgDurationMs).toBe(1000);
    });

    it('handles zero runs', async () => {
        const db = makeDb();
        vi.mocked(getTenantClient).mockReturnValue(db as any);
        const result = await repo.getAgentMetrics('tenant-1', '24h');
        expect(result.summary.successRate).toBe(0);
        expect(result.summary.avgDurationMs).toBe(0);
    });
});

describe('getAuditMetrics', () => {
    it('buckets by severity and computes summary stats', async () => {
        const db = makeDb({
            auditLog: {
                findMany: vi.fn().mockResolvedValue([
                    { eventType: 'login', status: 'success', severity: 'low', userType: 'user', user: 'a@b.co', timestamp: new Date('2026-02-09T00:00:00Z') },
                    { eventType: 'delete', status: 'error', severity: 'critical', userType: 'user', user: 'a@b.co', timestamp: new Date('2026-02-09T01:00:00Z') },
                    { eventType: 'sync', status: 'success', severity: 'medium', userType: 'system', user: 'system', timestamp: new Date('2026-02-08T00:00:00Z') },
                ]),
                count: vi.fn(),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getAuditMetrics('tenant-1', '7d');

        expect(result.summary.totalEvents).toBe(3);
        expect(result.summary.criticalCount).toBe(1);
        expect(result.summary.uniqueUsers).toBe(2);
        expect(result.summary.systemEvents).toBe(1);
        expect(result.summary.topUser).toBe('a@b.co');
        expect(result.byType.find(t => t.eventType === 'delete')?.severity).toBe('critical');
    });

    it('reports "N/A" top user with no non-system logs', async () => {
        const db = makeDb({
            auditLog: {
                findMany: vi.fn().mockResolvedValue([
                    { eventType: 'sync', status: 'success', severity: 'low', userType: 'system', user: 'system', timestamp: new Date() },
                ]),
                count: vi.fn(),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);
        const result = await repo.getAuditMetrics('tenant-1', '24h');
        expect(result.summary.topUser).toBe('N/A');
    });
});

describe('getInventoryMetrics', () => {
    it('aggregates resources by type/region/account and status', async () => {
        const db = makeDb({
            inventoryResource: {
                findMany: vi.fn().mockResolvedValue([
                    { resourceType: 'EC2', region: 'us-east-1', accountId: 'a1', status: 'running', discoveredAt: new Date('2026-02-09T00:00:00Z') },
                    { resourceType: 'RDS', region: 'us-east-1', accountId: 'a1', status: 'stopped', discoveredAt: new Date('2026-01-01T00:00:00Z') },
                ]),
            },
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'a1', name: 'Account One' }]) },
            inventorySyncStatus: { findFirst: vi.fn().mockResolvedValue({ syncedAt: new Date('2026-02-09T00:00:00Z'), accountsSynced: 1 }) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getInventoryMetrics('tenant-1', '7d');

        expect(result.summary.totalResources).toBe(2);
        expect(result.summary.running).toBe(1);
        expect(result.summary.stopped).toBe(1);
        expect(result.summary.newDiscovered).toBe(1);
        expect(result.byAccount[0].accountName).toBe('Account One');
    });
});

describe('getKnowledgeBaseMetrics', () => {
    it('summarizes knowledge bases and their data sources', async () => {
        const db = makeDb({
            knowledgeBase: {
                findMany: vi.fn().mockResolvedValue([{
                    id: 'kb1', name: 'KB One', status: 'active', vectorCount: 100,
                    dataSources: [
                        { id: 'ds1', name: 'Doc', sourceType: 'document', status: 'synced', vectorCount: 60, lastSyncAt: new Date('2026-02-09T00:00:00Z'), lastSyncError: null },
                        { id: 'ds2', name: 'Bucket', sourceType: 's3', status: 'error', vectorCount: 40, lastSyncAt: new Date('2026-02-08T00:00:00Z'), lastSyncError: 'timeout' },
                    ],
                }]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getKnowledgeBaseMetrics('tenant-1');

        expect(result.summary.totalKBs).toBe(1);
        expect(result.summary.totalVectors).toBe(100);
        expect(result.summary.syncErrors).toBe(1);
        expect(result.bySourceType).toEqual(expect.arrayContaining([{ sourceType: 'document', vectorCount: 60 }, { sourceType: 's3', vectorCount: 40 }]));
    });

    it('reports null lastSyncAt with no synced data sources', async () => {
        const db = makeDb({
            knowledgeBase: { findMany: vi.fn().mockResolvedValue([{ id: 'kb1', name: 'x', status: 'active', vectorCount: 0, dataSources: [] }]) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);
        const result = await repo.getKnowledgeBaseMetrics('tenant-1');
        expect(result.summary.lastSyncAt).toBeNull();
    });
});

describe('getHeroKpis', () => {
    it('builds all six hero cards including the pending-approvals count', async () => {
        const db = makeDb({
            agentOpsRun: { count: vi.fn().mockResolvedValue(2) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getHeroKpis('tenant-1', '7d');
        expect(result.cards).toHaveLength(6);
        expect(result.cards.map(c => c.id)).toEqual(
            expect.arrayContaining(['savings', 'schedule-success', 'accounts-synced', 'agent-runs', 'agent-approvals', 'critical-events']),
        );
    });
});

describe('getActionCenter', () => {
    it('surfaces failing executions, pending approvals, errored accounts, and critical events', async () => {
        const db = makeDb({
            scheduleExecution: { findMany: vi.fn().mockResolvedValue([
                { scheduleId: 's1', accountId: 'a1', status: 'failed', resourcesStarted: 0, resourcesStopped: 2, resourcesFailed: 1, executionTime: new Date(), errorMessage: 'boom' },
            ]) },
            agentOpsRun: { findMany: vi.fn().mockResolvedValue([{ id: 'run1', taskDescription: 'Stop things', createdAt: new Date() }]) },
            account: { findMany: vi.fn()
                .mockResolvedValueOnce([{ accountId: 'a1', name: 'Account One', connectionStatus: 'error', lastSyncedAt: null }])
                .mockResolvedValueOnce([{ accountId: 'a1', name: 'Account One' }]) },
            auditLog: { findMany: vi.fn().mockResolvedValue([{ eventType: 'delete', severity: 'critical', timestamp: new Date(), details: 'deleted x' }]) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getActionCenter('tenant-1', '7d');

        expect(result.failingExecutions[0]).toEqual(expect.objectContaining({ accountName: 'Account One', action: 'stop', reason: 'boom' }));
        expect(result.pendingAgentApprovals[0].taskName).toBe('Stop things');
        expect(result.accountsWithErrors[0].error).toContain('error');
        expect(result.criticalEvents[0].message).toBe('deleted x');
        expect(result.counts).toEqual({ failingExecutions: 1, pendingApprovals: 1, accountsWithErrors: 1, criticalEvents: 1 });
    });
});

describe('getCoverage', () => {
    it('classifies accounts as connected/stale/disconnected/never', async () => {
        const db = makeDb({
            account: { findMany: vi.fn().mockResolvedValue([
                { id: '1', accountId: 'a1', name: 'Fresh', connectionStatus: 'connected', lastSyncedAt: new Date('2026-02-10T11:00:00Z') },
                { id: '2', accountId: 'a2', name: 'Stale', connectionStatus: 'connected', lastSyncedAt: new Date('2026-01-01T00:00:00Z') },
                { id: '3', accountId: 'a3', name: 'Down', connectionStatus: 'error', lastSyncedAt: new Date() },
                { id: '4', accountId: 'a4', name: 'New', connectionStatus: 'connected', lastSyncedAt: null },
            ]) },
            inventorySyncStatus: { findFirst: vi.fn().mockResolvedValue({ syncedAt: new Date(), accountsSynced: 4 }) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getCoverage('tenant-1');

        expect(result.totalAccounts).toBe(4);
        expect(result.connectedAccounts).toBe(1);
        expect(result.staleAccounts).toBe(1);
        expect(result.disconnectedAccounts).toBe(1);
        expect(result.neverSyncedAccounts).toBe(1);
    });
});

describe('getCostAutomation', () => {
    it('builds recent executions, trend, and top-account summary', async () => {
        const db = makeDb({
            scheduleExecution: { findMany: vi.fn().mockResolvedValue([
                { scheduleId: 's1', accountId: 'a1', resourcesStopped: 5, executionTime: new Date(), status: 'success', duration: 1 },
            ]) },
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'a1', name: 'Account One' }]) },
            schedule: { findMany: vi.fn().mockResolvedValue([{ scheduleId: 's1', name: 'Sched One' }]) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getCostAutomation('tenant-1', '7d');

        expect(result.recentExecutions[0]).toEqual(expect.objectContaining({ scheduleName: 'Sched One', accountName: 'Account One', action: 'stop' }));
        expect(result.summary.topAccountName).toBe('Account One');
        expect(result.upcomingExecutions).toEqual([]);
    });

    it('falls back to "N/A" with no executions', async () => {
        const db = makeDb();
        vi.mocked(getTenantClient).mockReturnValue(db as any);
        const result = await repo.getCostAutomation('tenant-1', '24h');
        expect(result.summary.topAccountName).toBe('N/A');
        expect(result.summary.topAccountSavings).toBe(0);
    });
});

describe('getAgentActivity', () => {
    it('computes per-source success counts and top-tool success rates', async () => {
        const db = makeDb({
            agentOpsRun: {
                findMany: vi.fn()
                    .mockResolvedValueOnce([
                        { id: 'r1', source: 'slack', status: 'completed', durationMs: 100, createdAt: new Date(), taskDescription: 'x' },
                        { id: 'r2', source: 'slack', status: 'failed', durationMs: 50, createdAt: new Date(), taskDescription: 'y' },
                    ])
                    .mockResolvedValueOnce([{ id: 'r3', taskDescription: 'Pending', createdAt: new Date() }]),
            },
            agentOpsEvent: { findMany: vi.fn().mockResolvedValue([{ toolName: 'stop_ec2' }]) },
            scheduledTask: { count: vi.fn().mockResolvedValue(1) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getAgentActivity('tenant-1', '7d');

        expect(result.bySource).toEqual([{ source: 'slack', count: 2, successCount: 1 }]);
        expect(result.approvalQueue[0].taskName).toBe('Pending');
        expect(result.topTools[0]).toEqual(expect.objectContaining({ toolName: 'stop_ec2', count: 1, successCount: 0, successRate: 0 }));
    });
});

describe('getInventorySnapshot', () => {
    it('classifies resource statuses and computes per-account/type/region totals', async () => {
        const db = makeDb({
            inventoryResource: { findMany: vi.fn().mockResolvedValue([
                { resourceType: 'EC2', region: 'us-east-1', accountId: 'a1', status: 'running', discoveredAt: new Date() },
                { resourceType: 'EC2', region: 'us-east-1', accountId: 'a1', status: 'terminated', discoveredAt: new Date() },
                { resourceType: 'RDS', region: 'us-west-2', accountId: 'a2', status: 'pending', discoveredAt: new Date() },
                { resourceType: 'ASG', region: 'us-west-2', accountId: 'a2', status: 'weird-status', discoveredAt: new Date() },
            ]) },
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'a1', name: 'Account One' }, { accountId: 'a2', name: 'Account Two' }]) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getInventorySnapshot('tenant-1');

        expect(result.summary.running).toBe(1);
        expect(result.summary.terminated).toBe(1);
        expect(result.summary.pending).toBe(1);
        expect(result.summary.other).toBe(1);
        expect(result.statusBreakdown.find(s => s.status === 'weird-status')?.count).toBe(1);
    });
});

describe('getAuditSnapshot', () => {
    it('buckets by severity into openFindings and a timeline', async () => {
        const db = makeDb({
            auditLog: { findMany: vi.fn().mockResolvedValue([
                { eventType: 'login', status: 'success', severity: 'low', timestamp: new Date() },
                { eventType: 'delete', status: 'error', severity: 'critical', timestamp: new Date() },
                { eventType: 'update', status: 'error', severity: 'high', timestamp: new Date() },
            ]) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getAuditSnapshot('tenant-1', '7d');

        expect(result.summary.criticalCount).toBe(1);
        expect(result.summary.highCount).toBe(1);
        expect(result.openFindings.map(f => f.severity)).toEqual(expect.arrayContaining(['critical', 'high']));
        expect(result.openFindings.find(f => f.severity === 'medium')).toBeUndefined(); // zero-count severities are filtered out
    });
});

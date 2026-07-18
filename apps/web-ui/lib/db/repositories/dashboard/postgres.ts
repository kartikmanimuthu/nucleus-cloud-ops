/**
 * DashboardPostgresRepository
 *
 * PostgreSQL implementation of IDashboardRepository. All dashboard metric
 * queries live here; the service layer only formats/assembles responses.
 *
 * Multi-tenant safety: every query uses getTenantClient(tenantId).
 */
import { getTenantClient } from '@/lib/db/pg-config';
import type { IDashboardRepository } from './interface';
import type {
    TimeRange,
    KpiResponse,
    CostResponse,
    OperationsResponse,
    AgentResponse,
    AuditDashboardResponse,
    InventoryResponse,
    KnowledgeBaseResponse,
    HeroKpisResponse,
    ActionCenterResponse,
    CoverageResponse,
    CostAutomationResponse,
    AgentActivityResponse,
    InventorySnapshotResponse,
    AuditSnapshotResponse,
    SyncStatus,
} from '@/lib/dashboard-types';
import {
    getTimeRangeDate,
    getPreviousPeriodDate,
    bucketTimestamp,
    computeDelta,
} from '@/lib/dashboard-types';

const DEFAULT_HOURLY_COST = 0.10;

const HOURLY_COST_MAP: Record<string, number> = {
    EC2: 0.10,
    RDS: 0.15,
    ECS: 0.08,
    ASG: 0.10,
    DocumentDB: 0.12,
};

const STALE_SYNC_THRESHOLD_HOURS = 24;

function formatCurrency(value: number): string {
    return `$${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export class DashboardPostgresRepository implements IDashboardRepository {
    // ========================================================================
    // Legacy methods
    // ========================================================================

    async getKpiStats(tenantId: string, range: TimeRange): Promise<KpiResponse> {
        const db = getTenantClient(tenantId);
        const since = getTimeRangeDate(range);
        const prev = getPreviousPeriodDate(range);

        const [
            executions,
            prevExecutions,
            targetedResources,
            prevTargetedResources,
            activeAccounts,
            prevActiveAccounts,
            agentRuns,
            prevAgentRuns,
            auditLogs,
            prevAuditLogs,
            criticalAuditLogs,
        ] = await Promise.all([
            db.scheduleExecution.findMany({
                where: { executionTime: { gte: since } },
                select: { status: true, resourcesStopped: true, executionTime: true },
            }),
            db.scheduleExecution.findMany({
                where: { executionTime: { gte: prev.start, lt: prev.end } },
                select: { status: true, resourcesStopped: true },
            }),
            db.targetedResource.count(),
            db.targetedResource.count({ where: { createdAt: { lt: since } } }),
            db.account.count({ where: { active: true, connectionStatus: 'connected' } }),
            db.account.count({ where: { active: true, connectionStatus: 'connected', createdAt: { lt: since } } }),
            db.agentOpsRun.count({ where: { createdAt: { gte: since } } }),
            db.agentOpsRun.count({ where: { createdAt: { gte: prev.start, lt: prev.end } } }),
            db.auditLog.count({ where: { timestamp: { gte: since } } }),
            db.auditLog.count({ where: { timestamp: { gte: prev.start, lt: prev.end } } }),
            db.auditLog.count({ where: { timestamp: { gte: since }, severity: 'critical' } }),
        ]);

        const totalStopped = executions.reduce((sum, e) => sum + e.resourcesStopped, 0);
        const prevTotalStopped = prevExecutions.reduce((sum, e) => sum + e.resourcesStopped, 0);
        const savings = totalStopped * DEFAULT_HOURLY_COST;
        const prevSavings = prevTotalStopped * DEFAULT_HOURLY_COST;

        const successExecs = executions.filter(e => e.status === 'success').length;
        const totalExecs = executions.length;
        const successRate = totalExecs > 0 ? Math.round((successExecs / totalExecs) * 100) : 0;
        const prevSuccessExecs = prevExecutions.filter(e => e.status === 'success').length;
        const prevTotalExecs = prevExecutions.length;
        const prevSuccessRate = prevTotalExecs > 0 ? Math.round((prevSuccessExecs / prevTotalExecs) * 100) : 0;

        const sparklineBuckets = 7;
        const bucketDuration = (Date.now() - since.getTime()) / sparklineBuckets;
        const savingsSparkline = Array(sparklineBuckets).fill(0);
        for (const exec of executions) {
            const idx = Math.min(
                Math.floor((exec.executionTime.getTime() - since.getTime()) / bucketDuration),
                sparklineBuckets - 1
            );
            if (idx >= 0) savingsSparkline[idx] += exec.resourcesStopped * DEFAULT_HOURLY_COST;
        }

        return {
            cards: [
                {
                    id: 'savings',
                    label: 'Estimated Savings',
                    value: savings,
                    formattedValue: formatCurrency(savings),
                    ...computeDelta(savings, prevSavings),
                    sparkline: savingsSparkline,
                },
                {
                    id: 'resources',
                    label: 'Resources Managed',
                    value: targetedResources,
                    formattedValue: targetedResources.toLocaleString(),
                    ...computeDelta(targetedResources, prevTargetedResources),
                    sparkline: [],
                },
                {
                    id: 'accounts',
                    label: 'Active Accounts',
                    value: activeAccounts,
                    formattedValue: activeAccounts.toLocaleString(),
                    ...computeDelta(activeAccounts, prevActiveAccounts),
                    sparkline: [],
                },
                {
                    id: 'agent-runs',
                    label: 'Agent Runs',
                    value: agentRuns,
                    formattedValue: agentRuns.toLocaleString(),
                    ...computeDelta(agentRuns, prevAgentRuns),
                    sparkline: [],
                },
                {
                    id: 'success-rate',
                    label: 'Schedule Success Rate',
                    value: successRate,
                    formattedValue: `${successRate}%`,
                    ...computeDelta(successRate, prevSuccessRate),
                    sparkline: [],
                },
                {
                    id: 'audit-events',
                    label: 'Audit Events',
                    value: auditLogs,
                    formattedValue: `${auditLogs.toLocaleString()}${criticalAuditLogs > 0 ? ` (${criticalAuditLogs} critical)` : ''}`,
                    ...computeDelta(auditLogs, prevAuditLogs),
                    sparkline: [],
                },
            ],
        };
    }

    async getCostMetrics(tenantId: string, range: TimeRange): Promise<CostResponse> {
        const db = getTenantClient(tenantId);
        const since = getTimeRangeDate(range);

        const executions = await db.scheduleExecution.findMany({
            where: { executionTime: { gte: since } },
            select: { scheduleId: true, accountId: true, resourcesStopped: true, executionTime: true },
        });

        const accounts = await db.account.findMany({ select: { accountId: true, name: true } });
        const accountMap = new Map(accounts.map(a => [a.accountId, a.name]));

        const trendMap = new Map<string, { savings: number; resourcesStopped: number }>();
        for (const exec of executions) {
            const bucket = bucketTimestamp(exec.executionTime, range);
            const entry = trendMap.get(bucket) || { savings: 0, resourcesStopped: 0 };
            entry.savings += exec.resourcesStopped * DEFAULT_HOURLY_COST;
            entry.resourcesStopped += exec.resourcesStopped;
            trendMap.set(bucket, entry);
        }
        const trend = Array.from(trendMap.entries())
            .map(([time, data]) => ({ time, ...data }))
            .sort((a, b) => a.time.localeCompare(b.time));

        const accountSavings = new Map<string, number>();
        for (const exec of executions) {
            accountSavings.set(exec.accountId, (accountSavings.get(exec.accountId) || 0) + exec.resourcesStopped * DEFAULT_HOURLY_COST);
        }
        const byAccount = Array.from(accountSavings.entries())
            .map(([accountId, savings]) => ({
                accountId,
                accountName: accountMap.get(accountId) || accountId,
                savings,
            }))
            .sort((a, b) => b.savings - a.savings)
            .slice(0, 10);

        const totalSavings = executions.reduce((sum, e) => sum + e.resourcesStopped * DEFAULT_HOURLY_COST, 0);
        const daysInRange = range === '24h' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 90;
        const resourcesOptimized = executions.reduce((sum, e) => sum + e.resourcesStopped, 0);

        return {
            trend,
            byAccount,
            summary: {
                totalSavings,
                avgDailySavings: daysInRange > 0 ? totalSavings / daysInRange : 0,
                topAccount: byAccount[0]?.accountName || 'N/A',
                resourcesOptimized,
            },
        };
    }

    async getOperationsMetrics(tenantId: string, range: TimeRange): Promise<OperationsResponse> {
        const db = getTenantClient(tenantId);
        const since = getTimeRangeDate(range);

        const [accounts, executions, schedules] = await Promise.all([
            db.account.findMany({
                where: { active: true },
                select: { id: true, name: true, connectionStatus: true, lastSyncedAt: true },
            }),
            db.scheduleExecution.findMany({
                where: { executionTime: { gte: since } },
                select: {
                    scheduleId: true,
                    status: true,
                    resourcesStarted: true,
                    resourcesStopped: true,
                    resourcesFailed: true,
                    duration: true,
                    executionTime: true,
                },
            }),
            db.schedule.findMany({ select: { scheduleId: true, name: true } }),
        ]);

        const scheduleMap = new Map(schedules.map(s => [s.scheduleId, s.name]));

        const accountHealth = accounts.map(a => ({
            id: a.id,
            name: a.name,
            status: a.connectionStatus,
            lastSyncedAt: a.lastSyncedAt?.toISOString() || '',
        }));

        const timelineMap = new Map<string, { success: number; failed: number }>();
        for (const exec of executions) {
            const bucket = bucketTimestamp(exec.executionTime, range);
            const entry = timelineMap.get(bucket) || { success: 0, failed: 0 };
            if (exec.status === 'success') entry.success++;
            else if (exec.status === 'failed') entry.failed++;
            timelineMap.set(bucket, entry);
        }
        const executionTimeline = Array.from(timelineMap.entries())
            .map(([time, data]) => ({ time, ...data }))
            .sort((a, b) => a.time.localeCompare(b.time));

        const scheduleExecMap = new Map<string, { success: number; partialFail: number; fullFail: number }>();
        for (const exec of executions) {
            const entry = scheduleExecMap.get(exec.scheduleId) || { success: 0, partialFail: 0, fullFail: 0 };
            if (exec.status === 'success') {
                entry.success++;
            } else if (exec.resourcesFailed > 0 && (exec.resourcesStarted > 0 || exec.resourcesStopped > 0)) {
                entry.partialFail++;
            } else if (exec.resourcesFailed > 0) {
                entry.fullFail++;
            }
            scheduleExecMap.set(exec.scheduleId, entry);
        }
        const executionBySchedule = Array.from(scheduleExecMap.entries())
            .map(([scheduleId, data]) => ({
                scheduleId,
                scheduleName: scheduleMap.get(scheduleId) || scheduleId,
                ...data,
            }))
            .sort((a, b) => (b.success + b.partialFail + b.fullFail) - (a.success + a.partialFail + b.fullFail))
            .slice(0, 10);

        const totalExecutions = executions.length;
        const successCount = executions.filter(e => e.status === 'success').length;
        const totalDuration = executions.reduce((sum, e) => sum + (e.duration || 0), 0);

        return {
            accounts: accountHealth,
            executionTimeline,
            executionBySchedule,
            summary: {
                totalExecutions,
                successRate: totalExecutions > 0 ? Math.round((successCount / totalExecutions) * 100) : 0,
                avgDurationMs: totalExecutions > 0 ? Math.round((totalDuration / totalExecutions) * 1000) : 0,
                resourcesStarted: executions.reduce((sum, e) => sum + e.resourcesStarted, 0),
                resourcesStopped: executions.reduce((sum, e) => sum + e.resourcesStopped, 0),
                failedActions: executions.reduce((sum, e) => sum + e.resourcesFailed, 0),
            },
        };
    }

    async getAgentMetrics(tenantId: string, range: TimeRange): Promise<AgentResponse> {
        const db = getTenantClient(tenantId);
        const since = getTimeRangeDate(range);

        const [runs, toolEvents, scheduledTasks, chatSessions, messageCount] = await Promise.all([
            db.agentOpsRun.findMany({
                where: { createdAt: { gte: since } },
                select: { source: true, status: true, durationMs: true, createdAt: true },
            }),
            db.agentOpsEvent.findMany({
                where: { createdAt: { gte: since }, eventType: 'tool_call' },
                take: 10000,
                select: { toolName: true },
            }),
            db.scheduledTask.count({ where: { taskStatus: 'active' } }),
            db.chatSession.count({ where: { createdAt: { gte: since } } }),
            db.chatMessage.count({ where: { createdAt: { gte: since } } }),
        ]);

        const sourceMap = new Map<string, number>();
        for (const run of runs) sourceMap.set(run.source, (sourceMap.get(run.source) || 0) + 1);
        const bySource = Array.from(sourceMap.entries()).map(([source, count]) => ({ source, count }));

        const timelineMap = new Map<string, { completed: number; failed: number; inProgress: number; cancelled: number }>();
        for (const run of runs) {
            const bucket = bucketTimestamp(run.createdAt, range);
            const entry = timelineMap.get(bucket) || { completed: 0, failed: 0, inProgress: 0, cancelled: 0 };
            if (run.status === 'completed') entry.completed++;
            else if (run.status === 'failed') entry.failed++;
            else if (run.status === 'in_progress' || run.status === 'queued') entry.inProgress++;
            else if (run.status === 'cancelled') entry.cancelled++;
            timelineMap.set(bucket, entry);
        }
        const timeline = Array.from(timelineMap.entries())
            .map(([time, data]) => ({ time, ...data }))
            .sort((a, b) => a.time.localeCompare(b.time));

        const toolMap = new Map<string, number>();
        for (const event of toolEvents) {
            if (event.toolName) toolMap.set(event.toolName, (toolMap.get(event.toolName) || 0) + 1);
        }
        const topTools = Array.from(toolMap.entries())
            .map(([toolName, count]) => ({ toolName, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const completedRuns = runs.filter(r => r.status === 'completed');
        const totalDuration = completedRuns.reduce((sum, r) => sum + (r.durationMs || 0), 0);

        return {
            bySource,
            timeline,
            topTools,
            summary: {
                totalRuns: runs.length,
                successRate: runs.length > 0 ? Math.round((completedRuns.length / runs.length) * 100) : 0,
                avgDurationMs: completedRuns.length > 0 ? Math.round(totalDuration / completedRuns.length) : 0,
                activeScheduledTasks: scheduledTasks,
                chatSessions,
                messageCount,
            },
        };
    }

    async getAuditMetrics(tenantId: string, range: TimeRange): Promise<AuditDashboardResponse> {
        const db = getTenantClient(tenantId);
        const since = getTimeRangeDate(range);

        const logs = await db.auditLog.findMany({
            where: { timestamp: { gte: since } },
            select: {
                eventType: true,
                status: true,
                severity: true,
                userType: true,
                user: true,
                timestamp: true,
            },
            take: 5000,
            orderBy: { timestamp: 'desc' },
        });

        const timelineMap = new Map<string, { success: number; warning: number; error: number }>();
        for (const log of logs) {
            const bucket = bucketTimestamp(log.timestamp, range);
            const entry = timelineMap.get(bucket) || { success: 0, warning: 0, error: 0 };
            if (log.severity === 'critical' || log.severity === 'high') entry.error++;
            else if (log.severity === 'medium') entry.warning++;
            else entry.success++;
            timelineMap.set(bucket, entry);
        }
        const timeline = Array.from(timelineMap.entries())
            .map(([time, data]) => ({ time, ...data }))
            .sort((a, b) => a.time.localeCompare(b.time));

        const typeMap = new Map<string, { count: number; severity: string }>();
        for (const log of logs) {
            const existing = typeMap.get(log.eventType);
            if (existing) existing.count++;
            else typeMap.set(log.eventType, { count: 1, severity: log.severity });
        }
        const byType = Array.from(typeMap.entries())
            .map(([eventType, data]) => ({ eventType, ...data }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const statusMap = new Map<string, number>();
        for (const log of logs) statusMap.set(log.status, (statusMap.get(log.status) || 0) + 1);
        const byStatus = Array.from(statusMap.entries()).map(([status, count]) => ({ status, count }));

        const userSystemMap = new Map<string, { user: number; system: number }>();
        for (const log of logs) {
            const bucket = bucketTimestamp(log.timestamp, range);
            const entry = userSystemMap.get(bucket) || { user: 0, system: 0 };
            if (log.userType === 'system') entry.system++;
            else entry.user++;
            userSystemMap.set(bucket, entry);
        }
        const userVsSystem = Array.from(userSystemMap.entries())
            .map(([time, data]) => ({ time, ...data }))
            .sort((a, b) => a.time.localeCompare(b.time));

        const successCount = logs.filter(l => l.status === 'success').length;
        const criticalCount = logs.filter(l => l.severity === 'critical').length;
        const uniqueUsers = new Set(logs.map(l => l.user)).size;
        const systemEvents = logs.filter(l => l.userType === 'system').length;

        const userCountMap = new Map<string, number>();
        for (const log of logs) {
            if (log.userType !== 'system') userCountMap.set(log.user, (userCountMap.get(log.user) || 0) + 1);
        }
        const topUser = Array.from(userCountMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

        return {
            timeline,
            byType,
            byStatus,
            userVsSystem,
            summary: {
                totalEvents: logs.length,
                successRate: logs.length > 0 ? Math.round((successCount / logs.length) * 100) : 0,
                criticalCount,
                uniqueUsers,
                systemEvents,
                topUser,
            },
        };
    }

    async getInventoryMetrics(tenantId: string, range: TimeRange): Promise<InventoryResponse> {
        const db = getTenantClient(tenantId);
        const since = getTimeRangeDate(range);

        const [resources, accounts, latestSync] = await Promise.all([
            db.inventoryResource.findMany({
                take: 10000,
                select: { resourceType: true, region: true, accountId: true, status: true, discoveredAt: true },
            }),
            db.account.findMany({ select: { accountId: true, name: true } }),
            db.inventorySyncStatus.findFirst({
                where: { tenantId },
                orderBy: { syncedAt: 'desc' },
                select: { syncedAt: true, accountsSynced: true },
            }),
        ]);

        const accountMap = new Map(accounts.map(a => [a.accountId, a.name]));

        const typeMap = new Map<string, number>();
        for (const r of resources) typeMap.set(r.resourceType, (typeMap.get(r.resourceType) || 0) + 1);
        const byType = Array.from(typeMap.entries())
            .map(([resourceType, count]) => ({ resourceType, count }))
            .sort((a, b) => b.count - a.count);

        const regionMap = new Map<string, number>();
        for (const r of resources) regionMap.set(r.region, (regionMap.get(r.region) || 0) + 1);
        const byRegion = Array.from(regionMap.entries())
            .map(([region, count]) => ({ region, count }))
            .sort((a, b) => b.count - a.count);

        const accountBreakdown = new Map<string, Map<string, number>>();
        for (const r of resources) {
            if (!accountBreakdown.has(r.accountId)) accountBreakdown.set(r.accountId, new Map());
            const tb = accountBreakdown.get(r.accountId)!;
            tb.set(r.resourceType, (tb.get(r.resourceType) || 0) + 1);
        }
        const byAccount = Array.from(accountBreakdown.entries()).map(([accountId, breakdown]) => ({
            accountId,
            accountName: accountMap.get(accountId) || accountId,
            breakdown: Array.from(breakdown.entries()).map(([resourceType, count]) => ({ resourceType, count })),
        }));

        const running = resources.filter(r => r.status === 'running' || r.status === 'available' || r.status === 'active').length;
        const stopped = resources.filter(r => r.status === 'stopped' || r.status === 'inactive').length;
        const newDiscovered = resources.filter(r => r.discoveredAt >= since).length;

        return {
            byType,
            byRegion,
            byAccount,
            summary: {
                totalResources: resources.length,
                accountsSynced: latestSync?.accountsSynced || 0,
                lastScanAt: latestSync?.syncedAt?.toISOString() || '',
                running,
                stopped,
                other: resources.length - running - stopped,
                newDiscovered,
            },
        };
    }

    async getKnowledgeBaseMetrics(tenantId: string): Promise<KnowledgeBaseResponse> {
        const db = getTenantClient(tenantId);

        const kbs = await db.knowledgeBase.findMany({
            select: {
                id: true,
                name: true,
                status: true,
                vectorCount: true,
                dataSources: {
                    select: {
                        id: true,
                        name: true,
                        sourceType: true,
                        status: true,
                        vectorCount: true,
                        lastSyncAt: true,
                        lastSyncError: true,
                    },
                },
            },
        });

        const knowledgeBases = kbs.map(kb => ({
            id: kb.id,
            name: kb.name,
            status: kb.status,
            vectorCount: kb.vectorCount,
            dataSources: kb.dataSources.map(ds => ({
                id: ds.id,
                name: ds.name,
                sourceType: ds.sourceType,
                status: ds.status,
                vectorCount: ds.vectorCount,
                lastSyncAt: ds.lastSyncAt?.toISOString() || null,
                lastSyncError: ds.lastSyncError || null,
            })),
        }));

        const sourceTypeMap = new Map<string, number>();
        for (const kb of kbs) {
            for (const ds of kb.dataSources) sourceTypeMap.set(ds.sourceType, (sourceTypeMap.get(ds.sourceType) || 0) + ds.vectorCount);
        }
        const bySourceType = Array.from(sourceTypeMap.entries()).map(([sourceType, vectorCount]) => ({ sourceType, vectorCount }));

        const allDataSources = kbs.flatMap(kb => kb.dataSources);
        const syncErrors = allDataSources.filter(ds => ds.status === 'error').length;
        const lastSyncDates = allDataSources.filter(ds => ds.lastSyncAt).map(ds => ds.lastSyncAt!.getTime());
        const lastSyncAt = lastSyncDates.length > 0 ? new Date(Math.max(...lastSyncDates)).toISOString() : null;

        return {
            knowledgeBases,
            bySourceType,
            summary: {
                totalKBs: kbs.length,
                totalVectors: kbs.reduce((sum, kb) => sum + kb.vectorCount, 0),
                totalDataSources: allDataSources.length,
                syncErrors,
                lastSyncAt,
            },
        };
    }

    // ========================================================================
    // New zone-based methods
    // ========================================================================

    async getHeroKpis(tenantId: string, range: TimeRange): Promise<HeroKpisResponse> {
        const db = getTenantClient(tenantId);
        const since = getTimeRangeDate(range);
        const prev = getPreviousPeriodDate(range);

        const [
            executions,
            prevExecutions,
            activeAccounts,
            prevActiveAccounts,
            agentRuns,
            prevAgentRuns,
            auditLogs,
            prevAuditLogs,
            criticalAuditLogs,
            pendingApprovals,
        ] = await Promise.all([
            db.scheduleExecution.findMany({
                where: { executionTime: { gte: since } },
                select: { status: true, resourcesStopped: true, executionTime: true },
            }),
            db.scheduleExecution.findMany({
                where: { executionTime: { gte: prev.start, lt: prev.end } },
                select: { status: true, resourcesStopped: true },
            }),
            db.account.count({ where: { active: true, connectionStatus: 'connected' } }),
            db.account.count({ where: { active: true, connectionStatus: 'connected', createdAt: { lt: since } } }),
            db.agentOpsRun.count({ where: { createdAt: { gte: since } } }),
            db.agentOpsRun.count({ where: { createdAt: { gte: prev.start, lt: prev.end } } }),
            db.auditLog.count({ where: { timestamp: { gte: since } } }),
            db.auditLog.count({ where: { timestamp: { gte: prev.start, lt: prev.end } } }),
            db.auditLog.count({ where: { timestamp: { gte: since }, severity: 'critical' } }),
            db.agentOpsRun.count({ where: { status: 'awaiting_approval', createdAt: { gte: since } } }),
        ]);

        const totalStopped = executions.reduce((sum, e) => sum + e.resourcesStopped, 0);
        const prevTotalStopped = prevExecutions.reduce((sum, e) => sum + e.resourcesStopped, 0);
        const savings = totalStopped * DEFAULT_HOURLY_COST;
        const prevSavings = prevTotalStopped * DEFAULT_HOURLY_COST;

        const successExecs = executions.filter(e => e.status === 'success').length;
        const totalExecs = executions.length;
        const successRate = totalExecs > 0 ? Math.round((successExecs / totalExecs) * 100) : 0;
        const prevSuccessExecs = prevExecutions.filter(e => e.status === 'success').length;
        const prevTotalExecs = prevExecutions.length;
        const prevSuccessRate = prevTotalExecs > 0 ? Math.round((prevSuccessExecs / prevTotalExecs) * 100) : 0;

        const sparklineBuckets = 7;
        const bucketDuration = (Date.now() - since.getTime()) / sparklineBuckets;
        const savingsSparkline = Array(sparklineBuckets).fill(0);
        for (const exec of executions) {
            const idx = Math.min(
                Math.floor((exec.executionTime.getTime() - since.getTime()) / bucketDuration),
                sparklineBuckets - 1
            );
            if (idx >= 0) savingsSparkline[idx] += exec.resourcesStopped * DEFAULT_HOURLY_COST;
        }

        const cards: HeroKpisResponse['cards'] = [
            {
                id: 'savings',
                label: 'Est. Savings',
                value: savings,
                formattedValue: formatCurrency(savings),
                ...computeDelta(savings, prevSavings),
                higherIsBetter: true,
                sparkline: savingsSparkline,
                icon: 'savings',
                href: '/schedules?tab=executions',
            },
            {
                id: 'schedule-success',
                label: 'Schedule Success',
                value: successRate,
                formattedValue: `${successRate}%`,
                ...computeDelta(successRate, prevSuccessRate),
                higherIsBetter: true,
                sparkline: [],
                icon: 'success-rate',
                href: '/schedules?status=failed',
            },
            {
                id: 'accounts-synced',
                label: 'Accounts Synced',
                value: activeAccounts,
                formattedValue: activeAccounts.toLocaleString(),
                ...computeDelta(activeAccounts, prevActiveAccounts),
                higherIsBetter: true,
                sparkline: [],
                icon: 'accounts',
                href: '/accounts?filter=stale',
            },
            {
                id: 'agent-runs',
                label: 'Agent Runs',
                value: agentRuns,
                formattedValue: agentRuns.toLocaleString(),
                ...computeDelta(agentRuns, prevAgentRuns),
                higherIsBetter: false,
                sparkline: [],
                icon: 'agent-runs',
                href: '/agent-ops?range=24h',
            },
            {
                id: 'agent-approvals',
                label: 'Pending Approvals',
                value: pendingApprovals,
                formattedValue: pendingApprovals.toLocaleString(),
                delta: 0,
                deltaDirection: 'neutral',
                higherIsBetter: false,
                sparkline: [],
                icon: 'approvals',
                href: '/agent-ops?status=awaiting_approval',
            },
            {
                id: 'critical-events',
                label: 'Critical Events',
                value: criticalAuditLogs,
                formattedValue: criticalAuditLogs.toLocaleString(),
                ...computeDelta(criticalAuditLogs, 0),
                higherIsBetter: false,
                sparkline: [],
                icon: 'audit-events',
                href: '/audit-logs?severity=critical',
            },
        ];

        return { cards };
    }

    async getActionCenter(tenantId: string, range: TimeRange): Promise<ActionCenterResponse> {
        const db = getTenantClient(tenantId);
        const since = getTimeRangeDate(range);

        const [failedExecutions, pendingRuns, erroredAccounts, criticalLogs, accounts] = await Promise.all([
            db.scheduleExecution.findMany({
                where: { executionTime: { gte: since }, status: 'failed' },
                take: 10,
                orderBy: { executionTime: 'desc' },
                select: {
                    scheduleId: true,
                    accountId: true,
                    status: true,
                    resourcesStarted: true,
                    resourcesStopped: true,
                    resourcesFailed: true,
                    executionTime: true,
                    errorMessage: true,
                },
            }),
            db.agentOpsRun.findMany({
                where: { status: 'awaiting_approval', createdAt: { gte: since } },
                take: 10,
                orderBy: { createdAt: 'desc' },
                select: { id: true, taskDescription: true, createdAt: true },
            }),
            db.account.findMany({
                where: { active: true, connectionStatus: { not: 'connected' } },
                take: 10,
                select: { accountId: true, name: true, connectionStatus: true, lastSyncedAt: true },
            }),
            db.auditLog.findMany({
                where: { timestamp: { gte: since }, severity: { in: ['critical', 'high'] } },
                take: 10,
                orderBy: { timestamp: 'desc' },
                select: { eventType: true, severity: true, timestamp: true, details: true },
            }),
            db.account.findMany({ select: { accountId: true, name: true } }),
        ]);

        const accountMap = new Map(accounts.map(a => [a.accountId, a.name]));

        return {
            failingExecutions: failedExecutions.map(exec => ({
                scheduleId: exec.scheduleId,
                scheduleName: exec.scheduleId,
                accountId: exec.accountId,
                accountName: accountMap.get(exec.accountId) || exec.accountId,
                action: exec.resourcesStopped > 0 ? 'stop' : 'start',
                failedAt: exec.executionTime.toISOString(),
                reason: exec.errorMessage || 'Execution failed',
                resourcesAffected: exec.resourcesFailed,
                href: `/schedules/${exec.scheduleId}/executions`,
            })),
            pendingAgentApprovals: pendingRuns.map(run => ({
                runId: run.id,
                taskName: run.taskDescription || 'Agent run',
                requestedAt: run.createdAt.toISOString(),
                requesterName: null,
                href: `/agent-ops/runs/${run.id}`,
            })),
            accountsWithErrors: erroredAccounts.map(acc => ({
                accountId: acc.accountId,
                name: acc.name,
                error: `Connection status: ${acc.connectionStatus}`,
                lastSyncAt: acc.lastSyncedAt?.toISOString() || null,
                href: `/accounts/${acc.accountId}?tab=logs`,
            })),
            criticalEvents: criticalLogs.map(log => ({
                eventType: log.eventType,
                message: log.details || log.eventType,
                timestamp: log.timestamp.toISOString(),
                severity: log.severity as 'critical' | 'high',
                href: `/audit-logs?severity=${log.severity}`,
            })),
            counts: {
                failingExecutions: failedExecutions.length,
                pendingApprovals: pendingRuns.length,
                accountsWithErrors: erroredAccounts.length,
                criticalEvents: criticalLogs.length,
            },
        };
    }

    async getCoverage(tenantId: string): Promise<CoverageResponse> {
        const db = getTenantClient(tenantId);

        const [accounts, latestSync] = await Promise.all([
            db.account.findMany({
                select: { id: true, accountId: true, name: true, connectionStatus: true, lastSyncedAt: true },
            }),
            db.inventorySyncStatus.findFirst({
                where: { tenantId },
                orderBy: { syncedAt: 'desc' },
                select: { syncedAt: true, accountsSynced: true },
            }),
        ]);

        const now = Date.now();
        const staleThresholdMs = STALE_SYNC_THRESHOLD_HOURS * 60 * 60 * 1000;

        const computeStatus = (acc: { connectionStatus: string | null; lastSyncedAt: Date | null }): SyncStatus => {
            if (acc.connectionStatus !== 'connected') return 'disconnected';
            if (!acc.lastSyncedAt) return 'never';
            if (now - acc.lastSyncedAt.getTime() > staleThresholdMs) return 'stale';
            return 'connected';
        };

        const mappedAccounts = accounts.map(acc => ({
            id: acc.id,
            accountId: acc.accountId,
            name: acc.name,
            status: computeStatus(acc),
            lastSyncAt: acc.lastSyncedAt?.toISOString() || null,
            href: `/accounts/${acc.accountId}`,
        }));

        return {
            totalAccounts: accounts.length,
            connectedAccounts: mappedAccounts.filter(a => a.status === 'connected').length,
            staleAccounts: mappedAccounts.filter(a => a.status === 'stale').length,
            disconnectedAccounts: mappedAccounts.filter(a => a.status === 'disconnected').length,
            neverSyncedAccounts: mappedAccounts.filter(a => a.status === 'never').length,
            lastScanAt: latestSync?.syncedAt?.toISOString() || null,
            accountsSynced: latestSync?.accountsSynced || 0,
            accounts: mappedAccounts,
        };
    }

    async getCostAutomation(tenantId: string, range: TimeRange): Promise<CostAutomationResponse> {
        const db = getTenantClient(tenantId);
        const since = getTimeRangeDate(range);

        const executions = await db.scheduleExecution.findMany({
            where: { executionTime: { gte: since } },
            select: {
                scheduleId: true,
                accountId: true,
                resourcesStopped: true,
                executionTime: true,
                status: true,
                duration: true,
            },
            orderBy: { executionTime: 'desc' },
        });

        const [accounts, schedules] = await Promise.all([
            db.account.findMany({ select: { accountId: true, name: true } }),
            db.schedule.findMany({ select: { scheduleId: true, name: true } }),
        ]);

        const accountMap = new Map(accounts.map(a => [a.accountId, a.name]));
        const scheduleMap = new Map(schedules.map(s => [s.scheduleId, s.name]));

        const trendMap = new Map<string, { savings: number; resourcesStopped: number }>();
        const accountSavings = new Map<string, number>();
        const recentExecutions = executions.slice(0, 10).map(exec => ({
            scheduleId: exec.scheduleId,
            scheduleName: scheduleMap.get(exec.scheduleId) || exec.scheduleId,
            accountName: accountMap.get(exec.accountId) || exec.accountId,
            action: exec.resourcesStopped > 0 ? ('stop' as const) : ('start' as const),
            status: exec.status,
            time: exec.executionTime.toISOString(),
            savings: exec.resourcesStopped * DEFAULT_HOURLY_COST,
            href: `/schedules/${exec.scheduleId}/executions`,
        }));

        for (const exec of executions) {
            const bucket = bucketTimestamp(exec.executionTime, range);
            const entry = trendMap.get(bucket) || { savings: 0, resourcesStopped: 0 };
            entry.savings += exec.resourcesStopped * DEFAULT_HOURLY_COST;
            entry.resourcesStopped += exec.resourcesStopped;
            trendMap.set(bucket, entry);

            accountSavings.set(exec.accountId, (accountSavings.get(exec.accountId) || 0) + exec.resourcesStopped * DEFAULT_HOURLY_COST);
        }

        const trend = Array.from(trendMap.entries())
            .map(([time, data]) => ({ time, ...data }))
            .sort((a, b) => a.time.localeCompare(b.time));

        const topAccount = Array.from(accountSavings.entries())
            .map(([accountId, savings]) => ({
                accountId,
                accountName: accountMap.get(accountId) || accountId,
                savings,
            }))
            .sort((a, b) => b.savings - a.savings)[0];

        const totalSavings = executions.reduce((sum, e) => sum + e.resourcesStopped * DEFAULT_HOURLY_COST, 0);
        const daysInRange = range === '24h' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 90;
        const resourcesOptimized = executions.reduce((sum, e) => sum + e.resourcesStopped, 0);

        // Placeholder: upcoming executions require schedule recurrence parsing.
        const upcomingExecutions: CostAutomationResponse['upcomingExecutions'] = [];

        return {
            trend,
            recentExecutions,
            upcomingExecutions,
            summary: {
                totalSavings,
                avgDailySavings: daysInRange > 0 ? totalSavings / daysInRange : 0,
                resourcesOptimized,
                topAccountName: topAccount?.accountName || 'N/A',
                topAccountSavings: topAccount?.savings || 0,
            },
        };
    }

    async getAgentActivity(tenantId: string, range: TimeRange): Promise<AgentActivityResponse> {
        const db = getTenantClient(tenantId);
        const since = getTimeRangeDate(range);

        const [runs, toolEvents, scheduledTasks, pendingApprovals] = await Promise.all([
            db.agentOpsRun.findMany({
                where: { createdAt: { gte: since } },
                select: { id: true, source: true, status: true, durationMs: true, createdAt: true, taskDescription: true },
            }),
            db.agentOpsEvent.findMany({
                where: { createdAt: { gte: since }, eventType: 'tool_call' },
                take: 10000,
                select: { toolName: true },
            }),
            db.scheduledTask.count({ where: { taskStatus: 'active' } }),
            db.agentOpsRun.findMany({
                where: { status: 'awaiting_approval', createdAt: { gte: since } },
                take: 10,
                orderBy: { createdAt: 'desc' },
                select: { id: true, taskDescription: true, createdAt: true },
            }),
        ]);

        const sourceMap = new Map<string, { count: number; successCount: number }>();
        for (const run of runs) {
            const entry = sourceMap.get(run.source) || { count: 0, successCount: 0 };
            entry.count++;
            if (run.status === 'completed') entry.successCount++;
            sourceMap.set(run.source, entry);
        }
        const bySource = Array.from(sourceMap.entries()).map(([source, data]) => ({ source, ...data }));

        const toolMap = new Map<string, { count: number; successCount: number }>();
        for (const event of toolEvents) {
            if (!event.toolName) continue;
            const entry = toolMap.get(event.toolName) || { count: 0, successCount: 0 };
            entry.count++;
            toolMap.set(event.toolName, entry);
        }
        const topTools = Array.from(toolMap.entries())
            .map(([toolName, data]) => ({
                toolName,
                count: data.count,
                successCount: data.successCount,
                successRate: data.count > 0 ? Math.round((data.successCount / data.count) * 100) : 0,
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const completedRuns = runs.filter(r => r.status === 'completed');
        const totalDuration = completedRuns.reduce((sum, r) => sum + (r.durationMs || 0), 0);

        return {
            bySource,
            approvalQueue: pendingApprovals.map(run => ({
                runId: run.id,
                taskName: run.taskDescription || 'Agent run',
                requestedAt: run.createdAt.toISOString(),
                href: `/agent-ops/runs/${run.id}`,
            })),
            topTools,
            summary: {
                totalRuns: runs.length,
                successRate: runs.length > 0 ? Math.round((completedRuns.length / runs.length) * 100) : 0,
                avgDurationMs: completedRuns.length > 0 ? Math.round(totalDuration / completedRuns.length) : 0,
                activeScheduledTasks: scheduledTasks,
                pendingApprovals: pendingApprovals.length,
            },
        };
    }

    async getInventorySnapshot(tenantId: string): Promise<InventorySnapshotResponse> {
        const db = getTenantClient(tenantId);

        const [resources, accounts, latestSync] = await Promise.all([
            db.inventoryResource.findMany({
                take: 10000,
                select: { resourceType: true, region: true, accountId: true, status: true, discoveredAt: true },
            }),
            db.account.findMany({ select: { accountId: true, name: true } }),
            db.inventorySyncStatus.findFirst({
                where: { tenantId },
                orderBy: { syncedAt: 'desc' },
                select: { syncedAt: true, accountsSynced: true },
            }),
        ]);

        const accountMap = new Map(accounts.map(a => [a.accountId, a.name]));

        const typeMap = new Map<string, number>();
        for (const r of resources) typeMap.set(r.resourceType, (typeMap.get(r.resourceType) || 0) + 1);
        const byType = Array.from(typeMap.entries())
            .map(([resourceType, count]) => ({ resourceType, count }))
            .sort((a, b) => b.count - a.count);

        const regionMap = new Map<string, number>();
        for (const r of resources) regionMap.set(r.region, (regionMap.get(r.region) || 0) + 1);
        const byRegion = Array.from(regionMap.entries())
            .map(([region, count]) => ({ region, count }))
            .sort((a, b) => b.count - a.count);

        const accountTotals = new Map<string, number>();
        for (const r of resources) {
            accountTotals.set(r.accountId, (accountTotals.get(r.accountId) || 0) + 1);
        }
        const byAccount = Array.from(accountTotals.entries())
            .map(([accountId, total]) => ({
                accountId,
                accountName: accountMap.get(accountId) || accountId,
                total,
                href: `/inventory?account=${accountId}`,
            }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 10);

        const statusBuckets = new Map<string, number>();
        const incrementStatus = (status: string | null) => {
            const bucket = status ?? 'unknown';
            statusBuckets.set(bucket, (statusBuckets.get(bucket) || 0) + 1);
        };

        let running = 0;
        let stopped = 0;
        let terminated = 0;
        let pending = 0;

        for (const r of resources) {
            const status = (r.status || '').toLowerCase();
            if (['running', 'available', 'active'].includes(status)) {
                running++;
                incrementStatus('Running');
            } else if (['stopped', 'inactive'].includes(status)) {
                stopped++;
                incrementStatus('Stopped');
            } else if (['terminated', 'deleted'].includes(status)) {
                terminated++;
                incrementStatus('Terminated');
            } else if (['pending', 'creating'].includes(status)) {
                pending++;
                incrementStatus('Pending');
            } else {
                incrementStatus(status || 'Other');
            }
        }

        const statusBreakdown = Array.from(statusBuckets.entries())
            .map(([status, count]) => ({ status, count }))
            .sort((a, b) => b.count - a.count);

        return {
            byType,
            byRegion,
            byAccount,
            statusBreakdown,
            summary: {
                totalResources: resources.length,
                accountsSynced: latestSync?.accountsSynced || 0,
                lastScanAt: latestSync?.syncedAt?.toISOString() || null,
                running,
                stopped,
                terminated,
                pending,
                other: resources.length - running - stopped - terminated - pending,
                newDiscovered: 0, // Requires comparison with previous scan; computed separately.
            },
        };
    }

    async getAuditSnapshot(tenantId: string, range: TimeRange): Promise<AuditSnapshotResponse> {
        const db = getTenantClient(tenantId);
        const since = getTimeRangeDate(range);

        const logs = await db.auditLog.findMany({
            where: { timestamp: { gte: since } },
            select: { eventType: true, status: true, severity: true, timestamp: true },
            take: 5000,
            orderBy: { timestamp: 'desc' },
        });

        const timelineMap = new Map<string, { success: number; warning: number; error: number }>();
        const typeMap = new Map<string, number>();

        for (const log of logs) {
            const bucket = bucketTimestamp(log.timestamp, range);
            const entry = timelineMap.get(bucket) || { success: 0, warning: 0, error: 0 };
            if (log.severity === 'critical' || log.severity === 'high') entry.error++;
            else if (log.severity === 'medium') entry.warning++;
            else entry.success++;
            timelineMap.set(bucket, entry);

            typeMap.set(log.eventType, (typeMap.get(log.eventType) || 0) + 1);
        }

        const timeline = Array.from(timelineMap.entries())
            .map(([time, data]) => ({ time, ...data }))
            .sort((a, b) => a.time.localeCompare(b.time));

        const byType = Array.from(typeMap.entries())
            .map(([eventType, count]) => ({ eventType, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const severityCounts = new Map<string, number>();
        for (const log of logs) {
            if (log.severity) severityCounts.set(log.severity, (severityCounts.get(log.severity) || 0) + 1);
        }

        const openFindings = ['critical', 'high', 'medium', 'low']
            .map(severity => ({
                severity,
                count: severityCounts.get(severity) || 0,
                href: `/audit-logs?severity=${severity}`,
            }))
            .filter(item => item.count > 0);

        const successCount = logs.filter(l => l.status === 'success').length;
        const criticalCount = logs.filter(l => l.severity === 'critical').length;
        const highCount = logs.filter(l => l.severity === 'high').length;

        return {
            timeline,
            openFindings,
            byType,
            summary: {
                totalEvents: logs.length,
                successRate: logs.length > 0 ? Math.round((successCount / logs.length) * 100) : 0,
                criticalCount,
                highCount,
            },
        };
    }
}

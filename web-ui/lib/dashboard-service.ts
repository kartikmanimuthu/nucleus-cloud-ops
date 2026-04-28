import { getTenantClient } from '@/lib/db/pg-config';
import type {
  TimeRange,
  KpiResponse,
  CostResponse,
  OperationsResponse,
  AgentResponse,
  AuditDashboardResponse,
  InventoryResponse,
  KnowledgeBaseResponse,
} from '@/lib/dashboard-types';
import { getTimeRangeDate } from '@/lib/dashboard-types';

const DEFAULT_HOURLY_COST = 0.10;

function bucketTimestamp(date: Date, range: TimeRange): string {
  if (range === '24h') {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:00`;
  }
  if (range === '90d') {
    const day = date.getDay();
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - day);
    return `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function computeDelta(current: number, previous: number): { delta: number; deltaDirection: 'up' | 'down' | 'neutral' } {
  if (previous === 0) return { delta: 0, deltaDirection: 'neutral' };
  const delta = Math.round(((current - previous) / previous) * 100);
  return {
    delta: Math.abs(delta),
    deltaDirection: delta > 0 ? 'up' : delta < 0 ? 'down' : 'neutral',
  };
}

function getPreviousPeriodDate(range: TimeRange): { start: Date; end: Date } {
  const end = getTimeRangeDate(range);
  const now = new Date();
  const durationMs = now.getTime() - end.getTime();
  const start = new Date(end.getTime() - durationMs);
  return { start, end };
}

export class DashboardService {

  static async getKpiStats(tenantId: string, range: TimeRange): Promise<KpiResponse> {
    const db = getTenantClient(tenantId);
    const since = getTimeRangeDate(range);
    const prev = getPreviousPeriodDate(range);

    const [
      executions, prevExecutions,
      targetedResources, prevTargetedResources,
      activeAccounts, prevActiveAccounts,
      agentRuns, prevAgentRuns,
      auditLogs, prevAuditLogs,
      criticalAuditLogs,
    ] = await Promise.all([
      db.scheduleExecution.findMany({ where: { executionTime: { gte: since } }, select: { status: true, resourcesStopped: true, executionTime: true } }),
      db.scheduleExecution.findMany({ where: { executionTime: { gte: prev.start, lt: prev.end } }, select: { status: true, resourcesStopped: true } }),
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
      const idx = Math.min(Math.floor((exec.executionTime.getTime() - since.getTime()) / bucketDuration), sparklineBuckets - 1);
      if (idx >= 0) savingsSparkline[idx] += exec.resourcesStopped * DEFAULT_HOURLY_COST;
    }

    return {
      cards: [
        {
          id: 'savings',
          label: 'Estimated Savings',
          value: savings,
          formattedValue: `$${savings.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
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

  static async getCostMetrics(tenantId: string, range: TimeRange): Promise<CostResponse> {
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
      .map(([accountId, savings]) => ({ accountId, accountName: accountMap.get(accountId) || accountId, savings }))
      .sort((a, b) => b.savings - a.savings)
      .slice(0, 10);

    const totalSavings = executions.reduce((sum, e) => sum + e.resourcesStopped * DEFAULT_HOURLY_COST, 0);
    const daysInRange = range === '24h' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 90;
    const uniqueSchedules = new Set(executions.filter(e => e.resourcesStopped > 0).map(e => e.scheduleId));

    return {
      trend,
      byAccount,
      summary: {
        totalSavings,
        avgDailySavings: daysInRange > 0 ? totalSavings / daysInRange : 0,
        topAccount: byAccount[0]?.accountName || 'N/A',
        resourcesOptimized: uniqueSchedules.size,
      },
    };
  }

  static async getOperationsMetrics(tenantId: string, range: TimeRange): Promise<OperationsResponse> {
    const db = getTenantClient(tenantId);
    const since = getTimeRangeDate(range);

    const [accounts, executions, schedules] = await Promise.all([
      db.account.findMany({ where: { active: true }, select: { id: true, name: true, connectionStatus: true, lastSyncedAt: true } }),
      db.scheduleExecution.findMany({ where: { executionTime: { gte: since } }, select: { scheduleId: true, status: true, resourcesStarted: true, resourcesStopped: true, resourcesFailed: true, duration: true, executionTime: true } }),
      db.schedule.findMany({ select: { scheduleId: true, name: true } }),
    ]);

    const scheduleMap = new Map(schedules.map(s => [s.scheduleId, s.name]));

    const accountHealth = accounts.map(a => ({
      id: a.id, name: a.name, status: a.connectionStatus, lastSyncedAt: a.lastSyncedAt?.toISOString() || '',
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
      .map(([scheduleId, data]) => ({ scheduleId, scheduleName: scheduleMap.get(scheduleId) || scheduleId, ...data }))
      .sort((a, b) => (b.success + b.partialFail + b.fullFail) - (a.success + a.partialFail + a.fullFail))
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

  static async getAgentMetrics(tenantId: string, range: TimeRange): Promise<AgentResponse> {
    const db = getTenantClient(tenantId);
    const since = getTimeRangeDate(range);

    const [runs, toolEvents, scheduledTasks, chatSessions, messageCount] = await Promise.all([
      db.agentOpsRun.findMany({ where: { createdAt: { gte: since } }, select: { source: true, status: true, durationMs: true, createdAt: true } }),
      db.agentOpsEvent.findMany({ where: { createdAt: { gte: since }, eventType: 'tool_call' }, select: { toolName: true } }),
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

  static async getAuditMetrics(tenantId: string, range: TimeRange): Promise<AuditDashboardResponse> {
    const db = getTenantClient(tenantId);
    const since = getTimeRangeDate(range);

    const logs = await db.auditLog.findMany({
      where: { timestamp: { gte: since } },
      select: { eventType: true, status: true, severity: true, userType: true, user: true, timestamp: true },
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
      timeline, byType, byStatus, userVsSystem,
      summary: {
        totalEvents: logs.length,
        successRate: logs.length > 0 ? Math.round((successCount / logs.length) * 100) : 0,
        criticalCount, uniqueUsers, systemEvents, topUser,
      },
    };
  }

  static async getInventoryMetrics(tenantId: string, range: TimeRange): Promise<InventoryResponse> {
    const db = getTenantClient(tenantId);
    const since = getTimeRangeDate(range);

    const [resources, accounts, latestSync] = await Promise.all([
      db.inventoryResource.findMany({ select: { resourceType: true, region: true, accountId: true, status: true, discoveredAt: true } }),
      db.account.findMany({ select: { accountId: true, name: true } }),
      db.inventorySyncStatus.findFirst({ where: { tenantId }, orderBy: { syncedAt: 'desc' }, select: { syncedAt: true, accountsSynced: true } }),
    ]);

    const accountMap = new Map(accounts.map(a => [a.accountId, a.name]));

    const typeMap = new Map<string, number>();
    for (const r of resources) typeMap.set(r.resourceType, (typeMap.get(r.resourceType) || 0) + 1);
    const byType = Array.from(typeMap.entries()).map(([resourceType, count]) => ({ resourceType, count })).sort((a, b) => b.count - a.count);

    const regionMap = new Map<string, number>();
    for (const r of resources) regionMap.set(r.region, (regionMap.get(r.region) || 0) + 1);
    const byRegion = Array.from(regionMap.entries()).map(([region, count]) => ({ region, count })).sort((a, b) => b.count - a.count);

    const accountBreakdown = new Map<string, Map<string, number>>();
    for (const r of resources) {
      if (!accountBreakdown.has(r.accountId)) accountBreakdown.set(r.accountId, new Map());
      const tb = accountBreakdown.get(r.accountId)!;
      tb.set(r.resourceType, (tb.get(r.resourceType) || 0) + 1);
    }
    const byAccount = Array.from(accountBreakdown.entries()).map(([accountId, breakdown]) => ({
      accountId, accountName: accountMap.get(accountId) || accountId,
      breakdown: Array.from(breakdown.entries()).map(([resourceType, count]) => ({ resourceType, count })),
    }));

    const running = resources.filter(r => r.status === 'running' || r.status === 'available' || r.status === 'active').length;
    const stopped = resources.filter(r => r.status === 'stopped' || r.status === 'inactive').length;
    const newDiscovered = resources.filter(r => r.discoveredAt >= since).length;

    return {
      byType, byRegion, byAccount,
      summary: {
        totalResources: resources.length,
        accountsSynced: latestSync?.accountsSynced || 0,
        lastScanAt: latestSync?.syncedAt?.toISOString() || '',
        running, stopped, other: resources.length - running - stopped, newDiscovered,
      },
    };
  }

  static async getKnowledgeBaseMetrics(tenantId: string): Promise<KnowledgeBaseResponse> {
    const db = getTenantClient(tenantId);

    const kbs = await db.knowledgeBase.findMany({
      select: {
        id: true, name: true, status: true, vectorCount: true,
        dataSources: { select: { id: true, name: true, sourceType: true, status: true, vectorCount: true, lastSyncAt: true, lastSyncError: true } },
      },
    });

    const knowledgeBases = kbs.map(kb => ({
      id: kb.id, name: kb.name, status: kb.status, vectorCount: kb.vectorCount,
      dataSources: kb.dataSources.map(ds => ({
        id: ds.id, name: ds.name, sourceType: ds.sourceType, status: ds.status,
        lastSyncAt: ds.lastSyncAt?.toISOString() || null, lastSyncError: ds.lastSyncError || null,
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
      knowledgeBases, bySourceType,
      summary: {
        totalKBs: kbs.length,
        totalVectors: kbs.reduce((sum, kb) => sum + kb.vectorCount, 0),
        totalDataSources: allDataSources.length,
        syncErrors, lastSyncAt,
      },
    };
  }
}

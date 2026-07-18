export type TimeRange = '24h' | '7d' | '30d' | '90d';

// =============================================================================
// LEGACY DASHBOARD TYPES (deprecated — kept for backward compatibility while
// the old components are phased out. Remove once new zone-based UI is live.)
// =============================================================================

/** @deprecated Use zone-based types below. */
export interface KpiCard {
  id: string;
  label: string;
  value: number;
  formattedValue: string;
  delta: number;
  deltaDirection: 'up' | 'down' | 'neutral';
  sparkline: number[];
}

/** @deprecated Use zone-based types below. */
export interface KpiResponse {
  cards: KpiCard[];
}

/** @deprecated Use CostAutomationResponse below. */
export interface CostResponse {
  trend: { time: string; savings: number; resourcesStopped: number }[];
  byAccount: { accountId: string; accountName: string; savings: number }[];
  summary: {
    totalSavings: number;
    avgDailySavings: number;
    topAccount: string;
    resourcesOptimized: number;
  };
}

/** @deprecated Use CoverageResponse + CostAutomationResponse below. */
export interface OperationsResponse {
  accounts: { id: string; name: string; status: string; lastSyncedAt: string }[];
  executionTimeline: { time: string; success: number; failed: number }[];
  executionBySchedule: { scheduleId: string; scheduleName: string; success: number; partialFail: number; fullFail: number }[];
  summary: {
    totalExecutions: number;
    successRate: number;
    avgDurationMs: number;
    resourcesStarted: number;
    resourcesStopped: number;
    failedActions: number;
  };
}

/** @deprecated Use AgentActivityResponse below. */
export interface AgentResponse {
  bySource: { source: string; count: number }[];
  timeline: { time: string; completed: number; failed: number; inProgress: number; cancelled: number }[];
  topTools: { toolName: string; count: number }[];
  summary: {
    totalRuns: number;
    successRate: number;
    avgDurationMs: number;
    activeScheduledTasks: number;
    chatSessions: number;
    messageCount: number;
  };
}

/** @deprecated Use AuditSnapshotResponse below. */
export interface AuditDashboardResponse {
  timeline: { time: string; success: number; warning: number; error: number }[];
  byType: { eventType: string; count: number; severity: string }[];
  byStatus: { status: string; count: number }[];
  userVsSystem: { time: string; user: number; system: number }[];
  summary: {
    totalEvents: number;
    successRate: number;
    criticalCount: number;
    uniqueUsers: number;
    systemEvents: number;
    topUser: string;
  };
}

/** @deprecated Use InventorySnapshotResponse below. */
export interface InventoryResponse {
  byType: { resourceType: string; count: number }[];
  byRegion: { region: string; count: number }[];
  byAccount: { accountId: string; accountName: string; breakdown: { resourceType: string; count: number }[] }[];
  summary: {
    totalResources: number;
    accountsSynced: number;
    lastScanAt: string;
    running: number;
    stopped: number;
    other: number;
    newDiscovered: number;
  };
}

/** @deprecated Knowledge Base is removed from the main dashboard. */
export interface KnowledgeBaseResponse {
  knowledgeBases: {
    id: string;
    name: string;
    status: string;
    vectorCount: number;
    dataSources: {
      id: string;
      name: string;
      sourceType: string;
      status: string;
      vectorCount: number;
      lastSyncAt: string | null;
      lastSyncError: string | null;
    }[];
  }[];
  bySourceType: { sourceType: string; vectorCount: number }[];
  summary: {
    totalKBs: number;
    totalVectors: number;
    totalDataSources: number;
    syncErrors: number;
    lastSyncAt: string | null;
  };
}

// =============================================================================
// NEW ZONE-BASED DASHBOARD TYPES
// =============================================================================

/** A dashboard row/chart item that links to a filtered module view. */
export interface DashboardLink {
  href: string;
}

/** Direction of a period-over-period change. */
export type DeltaDirection = 'up' | 'down' | 'neutral';

/** A hero KPI card shown in the top row. */
export interface HeroKpiCard extends DashboardLink {
  id: 'savings' | 'schedule-success' | 'accounts-synced' | 'agent-runs' | 'agent-approvals' | 'critical-events';
  label: string;
  value: number;
  formattedValue: string;
  delta: number;
  deltaDirection: DeltaDirection;
  /** Whether an increase is good (affects delta color). */
  higherIsBetter: boolean;
  sparkline: number[];
  icon: string;
}

export interface HeroKpisResponse {
  cards: HeroKpiCard[];
}

/** Items in the Action Center: things that need operator attention. */
export interface ActionCenterResponse {
  failingExecutions: ({
    scheduleId: string;
    scheduleName: string;
    accountId: string;
    accountName: string;
    action: 'start' | 'stop';
    failedAt: string;
    reason: string;
    resourcesAffected: number;
  } & DashboardLink)[];
  pendingAgentApprovals: ({
    runId: string;
    taskName: string;
    requestedAt: string;
    requesterName: string | null;
  } & DashboardLink)[];
  accountsWithErrors: ({
    accountId: string;
    name: string;
    error: string;
    lastSyncAt: string | null;
  } & DashboardLink)[];
  criticalEvents: ({
    eventType: string;
    message: string;
    timestamp: string;
    severity: 'critical' | 'high';
  } & DashboardLink)[];
  counts: {
    failingExecutions: number;
    pendingApprovals: number;
    accountsWithErrors: number;
    criticalEvents: number;
  };
}

/** Account discovery/sync coverage. */
export type SyncStatus = 'connected' | 'disconnected' | 'stale' | 'never';

export interface CoverageResponse {
  totalAccounts: number;
  connectedAccounts: number;
  staleAccounts: number;
  disconnectedAccounts: number;
  neverSyncedAccounts: number;
  lastScanAt: string | null;
  accountsSynced: number;
  accounts: ({
    id: string;
    accountId: string;
    name: string;
    status: SyncStatus;
    lastSyncAt: string | null;
  } & DashboardLink)[];
}

/** Cost optimization + recent/upcoming schedule automation. */
export interface CostAutomationResponse {
  trend: { time: string; savings: number; resourcesStopped: number }[];
  recentExecutions: ({
    scheduleId: string;
    scheduleName: string;
    accountName: string;
    action: 'start' | 'stop';
    status: string;
    time: string;
    savings: number;
  } & DashboardLink)[];
  upcomingExecutions: ({
    scheduleId: string;
    scheduleName: string;
    accountName: string;
    action: string;
    nextRun: string;
  } & DashboardLink)[];
  summary: {
    totalSavings: number;
    avgDailySavings: number;
    resourcesOptimized: number;
    topAccountName: string;
    topAccountSavings: number;
  };
}

/** Agent / AI Ops activity. */
export interface AgentActivityResponse {
  bySource: { source: string; count: number; successCount: number }[];
  approvalQueue: ({
    runId: string;
    taskName: string;
    requestedAt: string;
  } & DashboardLink)[];
  topTools: {
    toolName: string;
    count: number;
    successCount: number;
    successRate: number;
  }[];
  summary: {
    totalRuns: number;
    successRate: number;
    avgDurationMs: number;
    activeScheduledTasks: number;
    pendingApprovals: number;
  };
}

/** Inventory snapshot (point-in-time). */
export interface InventorySnapshotResponse {
  byType: { resourceType: string; count: number }[];
  byRegion: { region: string; count: number }[];
  byAccount: ({
    accountId: string;
    accountName: string;
    total: number;
  } & DashboardLink)[];
  statusBreakdown: { status: string; count: number }[];
  summary: {
    totalResources: number;
    accountsSynced: number;
    lastScanAt: string | null;
    running: number;
    stopped: number;
    terminated: number;
    pending: number;
    other: number;
    newDiscovered: number;
  };
}

/** Security & audit snapshot. */
export interface AuditSnapshotResponse {
  timeline: { time: string; success: number; warning: number; error: number }[];
  openFindings: ({ severity: string; count: number } & DashboardLink)[];
  byType: { eventType: string; count: number }[];
  summary: {
    totalEvents: number;
    successRate: number;
    criticalCount: number;
    highCount: number;
  };
}

// =============================================================================
// TIME-RANGE HELPERS
// =============================================================================

export function getTimeRangeDate(range: TimeRange): Date {
  const now = new Date();
  switch (range) {
    case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case '90d': return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  }
}

export function getTimeBucketFormat(range: TimeRange): { bucketMs: number; format: string } {
  switch (range) {
    case '24h': return { bucketMs: 60 * 60 * 1000, format: 'HH:00' };
    case '7d': return { bucketMs: 24 * 60 * 60 * 1000, format: 'MMM dd' };
    case '30d': return { bucketMs: 24 * 60 * 60 * 1000, format: 'MMM dd' };
    case '90d': return { bucketMs: 7 * 24 * 60 * 60 * 1000, format: 'MMM dd' };
  }
}

export function bucketTimestamp(date: Date, range: TimeRange): string {
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

export function computeDelta(current: number, previous: number): { delta: number; deltaDirection: DeltaDirection } {
  if (previous === 0) return { delta: 0, deltaDirection: 'neutral' };
  const rawDelta = Math.round(((current - previous) / previous) * 100);
  return {
    delta: Math.abs(rawDelta),
    deltaDirection: rawDelta > 0 ? 'up' : rawDelta < 0 ? 'down' : 'neutral',
  };
}

export function getPreviousPeriodDate(range: TimeRange): { start: Date; end: Date } {
  const end = getTimeRangeDate(range);
  const now = new Date();
  const durationMs = now.getTime() - end.getTime();
  const start = new Date(end.getTime() - durationMs);
  return { start, end };
}

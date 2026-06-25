export type TimeRange = '24h' | '7d' | '30d' | '90d';

export interface KpiCard {
  id: string;
  label: string;
  value: number;
  formattedValue: string;
  delta: number;
  deltaDirection: 'up' | 'down' | 'neutral';
  sparkline: number[];
}

export interface KpiResponse {
  cards: KpiCard[];
}

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

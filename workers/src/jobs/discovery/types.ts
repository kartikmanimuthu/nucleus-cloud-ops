// workers/src/jobs/discovery/types.ts

// ---------------------------------------------------------------------------
// Job payload types for discovery (discriminated union, matches kb-sync pattern)
// ---------------------------------------------------------------------------

export interface DiscoveryFanOutJob {
  type: 'fan-out';
}

export interface DiscoveryScanJob {
  type: 'scan';
  tenantId: string;
  accountId?: string;
  triggeredBy: 'cron' | 'web-ui';
  userEmail?: string;
  correlationId?: string;
}

export type DiscoveryJob = DiscoveryFanOutJob | DiscoveryScanJob;

// ---------------------------------------------------------------------------
// Domain entities
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  tenantId: string;
  accountId: string;
  name: string;
  roleArn: string;
  externalId?: string;
  regions: string[];
  active: boolean;
}

export interface Resource {
  resourceType: string;
  resourceId: string;
  region: string;
  service: string;
  name?: string;
  state?: string;
  resourceArn?: string;
  tags: Record<string, string>;
  rawData: unknown;
}

// ---------------------------------------------------------------------------
// Scanfile schema
// ---------------------------------------------------------------------------

export interface EnrichmentStep {
  type: 'tags' | 'describe' | 'detail';
  method: string;
  arnKey?: string;
  nameKey?: string;
  inputKey?: string;
  resultKey?: string;
  idKey?: string;
  batchSize?: number;
  mergeKey?: string;
}

export interface ScanConstraints {
  regionFilter?: boolean;
  regionOverride?: string;
  scopes?: string[];
}

export interface ScanConfig {
  service: string;
  function: string;
  result_key: string;
  parameters?: Record<string, unknown>;
  enrichments?: EnrichmentStep[];
  constraints?: ScanConstraints;
}

// ---------------------------------------------------------------------------
// Scan results
// ---------------------------------------------------------------------------

export interface ScanResult {
  resources: Resource[];
  regionsScanned: number;
  servicesScanned: number;
  elapsedMs: number;
  errors?: string[];
}

export interface SyncStatus {
  scanId: string;
  tenantId: string;
  totalResources: number;
  accountsSynced: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// STS Credentials (shared shape with scheduler)
// ---------------------------------------------------------------------------

export interface AssumedCredentials {
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
  region: string;
}

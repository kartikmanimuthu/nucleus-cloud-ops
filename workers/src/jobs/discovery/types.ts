// workers/src/jobs/discovery/types.ts

export interface DiscoveryFanOutJob {
  triggeredBy?: 'cron' | 'web-ui';
}

export interface DiscoveryScanJob {
  tenantId: string;
  accountId?: string;       // if set, scan only this account
  triggeredBy: 'cron' | 'web-ui';
  userEmail?: string;
  correlationId?: string;
}

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

export interface AssumedCredentials {
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  region: string;
}

export interface EnrichmentStep {
  type: 'tags' | 'describe' | 'detail';
  method: string;
  arnKey?: string;
  nameKey?: string;
  inputKey?: string;
  resultKey?: string;
  batchSize?: number;
  idKey?: string;
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
  result_key?: string;
  parameters?: Record<string, unknown>;
  enrichments?: EnrichmentStep[];
  constraints?: ScanConstraints;
}

export interface Resource {
  resourceType: string;
  resourceId: string;
  resourceArn: string;
  name: string;
  region: string;
  service: string;
  state: string;
  tags: Record<string, string>;
  metadata?: Record<string, unknown>;
  rawData?: unknown;
}

export interface ScanResult {
  resources: Resource[];
  regionsScanned: number;
  servicesScanned: number;
  elapsedMs: number;
  errors: string[];
}

export interface SyncStatus {
  scanId: string;
  tenantId: string;
  totalResources: number;
  accountsSynced: number;
  syncedAt: Date;
}

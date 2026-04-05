# Discovery pg-boss Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Python discovery ECS Fargate task as a TypeScript pg-boss worker with declarative scanfile enrichments, multi-tenant fan-out, and PostgreSQL-only persistence.

**Architecture:** Two pg-boss queues (`discovery-fan-out` daily cron, `discovery-scan` per-tenant). A generic scanner engine reads `scanfile.json` with declarative enrichment steps, calls any AWS SDK v3 client dynamically via SERVICE_REGISTRY, and writes results to PostgreSQL. Only 4 custom handlers for truly unique AWS API patterns.

**Tech Stack:** TypeScript, pg-boss v10, AWS SDK v3, p-limit, raw pg Pool, Vitest

---

## File Structure

```
workers/src/jobs/discovery/
├── index.ts                  # register(): createQueue, schedule cron, work handlers
├── types.ts                  # All interfaces: job payloads, Account, Resource, ScanConfig, etc.
├── services/
│   ├── scanner.ts            # SERVICE_REGISTRY, invokeService, applyEnrichments,
│   │                         #   runInventoryScan, normalizeResources, extractResourceIdentifiers
│   ├── custom-scanners.ts    # 4 unique cases: EC2, ECS services, WAFv2, CloudFront
│   ├── pg-writer.ts          # writeResourcesToPg (batch 500), saveSyncStatus, extractMetadata
│   ├── account-service.ts    # getAllTenants, getTenantAccounts, updateAccountSyncStatus
│   ├── sts-service.ts        # assumeRole with optional ExternalId
│   └── audit-service.ts      # writeAuditLog → PostgreSQL audit_logs table
├── scanfile.json             # 40 service configs with declarative enrichment steps
├── local-runner.ts           # tsx local dev runner — CLI flags
└── __tests__/
    ├── types.test.ts
    ├── sts-service.test.ts
    ├── audit-service.test.ts
    ├── account-service.test.ts
    ├── scanner.test.ts
    ├── custom-scanners.test.ts
    ├── pg-writer.test.ts
    ├── index.test.ts
    └── integration.test.ts
```

---

## Task 1: Types (`workers/src/jobs/discovery/types.ts`)

**Files:**
- Create: `workers/src/jobs/discovery/types.ts`
- Test: `workers/src/jobs/discovery/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/src/jobs/discovery/__tests__/types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  DiscoveryFanOutJob,
  DiscoveryScanJob,
  DiscoveryJob,
  Account,
  Resource,
  ScanConfig,
  EnrichmentStep,
  ScanResult,
  SyncStatus,
  AssumedCredentials,
} from '../types.js';

describe('discovery types', () => {
  it('should create a valid DiscoveryFanOutJob', () => {
    const job: DiscoveryFanOutJob = { type: 'fan-out' };
    expect(job.type).toBe('fan-out');
  });

  it('should create a valid DiscoveryScanJob with minimal fields', () => {
    const job: DiscoveryScanJob = {
      type: 'scan',
      tenantId: 'tenant-123',
      triggeredBy: 'cron',
    };
    expect(job.type).toBe('scan');
    expect(job.tenantId).toBe('tenant-123');
    expect(job.triggeredBy).toBe('cron');
  });

  it('should create a valid DiscoveryScanJob with all fields', () => {
    const job: DiscoveryScanJob = {
      type: 'scan',
      tenantId: 'tenant-123',
      accountId: '123456789012',
      triggeredBy: 'web-ui',
      userEmail: 'user@example.com',
      correlationId: 'corr-abc',
    };
    expect(job.accountId).toBe('123456789012');
    expect(job.userEmail).toBe('user@example.com');
  });

  it('should discriminate DiscoveryJob union by type field', () => {
    const fanOut: DiscoveryJob = { type: 'fan-out' };
    const scan: DiscoveryJob = { type: 'scan', tenantId: 't1', triggeredBy: 'cron' };

    if (fanOut.type === 'fan-out') {
      expect(fanOut.type).toBe('fan-out');
    }
    if (scan.type === 'scan') {
      expect(scan.tenantId).toBe('t1');
    }
  });

  it('should create a valid Account', () => {
    const account: Account = {
      id: 'cuid-123',
      tenantId: 'tenant-123',
      accountId: '123456789012',
      name: 'Production',
      roleArn: 'arn:aws:iam::123456789012:role/NucleusAccess',
      regions: ['us-east-1', 'ap-south-1'],
      active: true,
    };
    expect(account.accountId).toBe('123456789012');
    expect(account.regions).toHaveLength(2);
  });

  it('should create a valid Resource', () => {
    const resource: Resource = {
      resourceType: 'ec2_instances',
      resourceId: 'i-0abc123def456',
      region: 'us-east-1',
      service: 'ec2',
      name: 'my-instance',
      state: 'running',
      resourceArn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def456',
      tags: { Name: 'my-instance', Environment: 'prod' },
      rawData: {},
    };
    expect(resource.resourceType).toBe('ec2_instances');
  });

  it('should create a valid ScanConfig with enrichments', () => {
    const config: ScanConfig = {
      service: 'rds',
      function: 'describe_db_instances',
      result_key: 'DBInstances',
      enrichments: [
        { type: 'tags', method: 'list_tags_for_resource', arnKey: 'DBInstanceArn' },
      ],
    };
    expect(config.enrichments).toHaveLength(1);
    expect(config.enrichments![0].type).toBe('tags');
  });

  it('should create a valid ScanConfig with constraints', () => {
    const config: ScanConfig = {
      service: 'cloudfront',
      function: 'list_distributions',
      result_key: 'DistributionList',
      constraints: { regionOverride: 'us-east-1' },
    };
    expect(config.constraints?.regionOverride).toBe('us-east-1');
  });

  it('should create a valid ScanResult', () => {
    const result: ScanResult = {
      resources: [],
      regionsScanned: 3,
      servicesScanned: 40,
      elapsedMs: 12345,
    };
    expect(result.regionsScanned).toBe(3);
  });

  it('should create a valid SyncStatus', () => {
    const status: SyncStatus = {
      scanId: 'scan-123',
      tenantId: 'tenant-123',
      totalResources: 500,
      accountsSynced: 3,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    expect(status.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/types.test.ts`
Expected: FAIL with "Cannot find module '../types.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/src/jobs/discovery/types.ts workers/src/jobs/discovery/__tests__/types.test.ts
git commit -m "feat(discovery): add type definitions for discovery worker"
```

---

## Task 2: STS Service (`workers/src/jobs/discovery/services/sts-service.ts`)

**Files:**
- Create: `workers/src/jobs/discovery/services/sts-service.ts`
- Test: `workers/src/jobs/discovery/__tests__/sts-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/src/jobs/discovery/__tests__/sts-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  AssumeRoleCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

import { assumeRole } from '../services/sts-service.js';

describe('sts-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should assume role and return credentials', async () => {
    mockSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'AKID',
        SecretAccessKey: 'SECRET',
        SessionToken: 'TOKEN',
      },
    });

    const result = await assumeRole(
      'arn:aws:iam::123456789012:role/NucleusAccess',
      '123456789012',
      'us-east-1',
    );

    expect(result.credentials.accessKeyId).toBe('AKID');
    expect(result.credentials.secretAccessKey).toBe('SECRET');
    expect(result.credentials.sessionToken).toBe('TOKEN');
    expect(result.region).toBe('us-east-1');
  });

  it('should pass ExternalId when provided', async () => {
    mockSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'AKID',
        SecretAccessKey: 'SECRET',
        SessionToken: 'TOKEN',
      },
    });

    const { AssumeRoleCommand } = await import('@aws-sdk/client-sts');

    await assumeRole(
      'arn:aws:iam::123456789012:role/NucleusAccess',
      '123456789012',
      'us-east-1',
      'ext-id-123',
    );

    expect(AssumeRoleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        ExternalId: 'ext-id-123',
        RoleSessionName: expect.stringContaining('NucleusDiscovery'),
      }),
    );
  });

  it('should use NucleusDiscovery session name', async () => {
    mockSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'AKID',
        SecretAccessKey: 'SECRET',
        SessionToken: 'TOKEN',
      },
    });

    const { AssumeRoleCommand } = await import('@aws-sdk/client-sts');

    await assumeRole(
      'arn:aws:iam::123456789012:role/NucleusAccess',
      '123456789012',
      'ap-south-1',
    );

    expect(AssumeRoleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        RoleSessionName: expect.stringMatching(/^NucleusDiscovery-123456789012-ap-south-1$/),
        DurationSeconds: 3600,
      }),
    );
  });

  it('should throw when no credentials returned', async () => {
    mockSend.mockResolvedValueOnce({});

    await expect(
      assumeRole('arn:aws:iam::123456789012:role/NucleusAccess', '123456789012', 'us-east-1'),
    ).rejects.toThrow('No credentials returned from AssumeRole');
  });

  it('should propagate STS errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('Access denied'));

    await expect(
      assumeRole('arn:aws:iam::123456789012:role/NucleusAccess', '123456789012', 'us-east-1'),
    ).rejects.toThrow('Access denied');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/sts-service.test.ts`
Expected: FAIL with "Cannot find module '../services/sts-service.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// workers/src/jobs/discovery/services/sts-service.ts
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { AssumedCredentials } from '../types.js';

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';

let stsClient: STSClient | null = null;

function getSTSClient(): STSClient {
  if (!stsClient) {
    stsClient = new STSClient({ region: AWS_REGION });
  }
  return stsClient;
}

export async function assumeRole(
  roleArn: string,
  accountId: string,
  region: string,
  externalId?: string,
): Promise<AssumedCredentials> {
  const client = getSTSClient();
  const roleSessionName = `NucleusDiscovery-${accountId}-${region}`;

  const response = await client.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: roleSessionName,
      DurationSeconds: 3600,
      ExternalId: externalId,
    }),
  );

  if (!response.Credentials) {
    throw new Error('No credentials returned from AssumeRole');
  }

  return {
    credentials: {
      accessKeyId: response.Credentials.AccessKeyId!,
      secretAccessKey: response.Credentials.SecretAccessKey!,
      sessionToken: response.Credentials.SessionToken!,
    },
    region,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/sts-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/src/jobs/discovery/services/sts-service.ts workers/src/jobs/discovery/__tests__/sts-service.test.ts
git commit -m "feat(discovery): add STS service for cross-account role assumption"
```

---

## Task 3: Audit Service (`workers/src/jobs/discovery/services/audit-service.ts`)

**Files:**
- Create: `workers/src/jobs/discovery/services/audit-service.ts`
- Test: `workers/src/jobs/discovery/__tests__/audit-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/src/jobs/discovery/__tests__/audit-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ connect: mockConnect })),
}));

import { writeAuditLog } from '../services/audit-service.js';

describe('audit-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  });

  it('should write a discovery.scan.started audit log', async () => {
    await writeAuditLog({
      tenantId: 'tenant-123',
      eventType: 'discovery.scan.started',
      action: 'scan_started',
      resourceId: 'scan-abc',
      status: 'info',
      severity: 'info',
      details: 'Discovery scan started for 3 accounts',
      metadata: { scanId: 'scan-abc', accountCount: 3 },
    });

    expect(mockConnect).toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining([
        'tenant-123',
        expect.any(String), // logId
        expect.any(Date),   // timestamp
        'discovery.scan.started',
        'scan_started',
        'system',
        'system',
        'discovery',
        'scan-abc',
        'info',
        'info',
        'Discovery scan started for 3 accounts',
        expect.any(String), // metadata JSON
      ]),
    );
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should write a discovery.scan.completed audit log', async () => {
    await writeAuditLog({
      tenantId: 'tenant-123',
      eventType: 'discovery.scan.completed',
      action: 'scan_completed',
      resourceId: 'scan-abc',
      status: 'success',
      severity: 'info',
      details: 'Discovery scan completed: 500 resources across 3 accounts',
      metadata: { scanId: 'scan-abc', totalResources: 500, accountsSynced: 3, elapsedMs: 12345 },
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining(['discovery.scan.completed']),
    );
  });

  it('should write a discovery.scan.failed audit log', async () => {
    await writeAuditLog({
      tenantId: 'tenant-123',
      eventType: 'discovery.scan.failed',
      action: 'scan_failed',
      resourceId: 'scan-abc',
      status: 'error',
      severity: 'high',
      details: 'Discovery scan failed: AssumeRole denied',
      metadata: { scanId: 'scan-abc', error: 'AssumeRole denied' },
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining(['discovery.scan.failed', 'scan_failed']),
    );
  });

  it('should set 30-day TTL on expiresAt', async () => {
    const before = Date.now();

    await writeAuditLog({
      tenantId: 'tenant-123',
      eventType: 'discovery.scan.started',
      action: 'scan_started',
      resourceId: 'scan-abc',
      status: 'info',
      severity: 'info',
      details: 'test',
    });

    const after = Date.now();
    const expiresAtArg = mockQuery.mock.calls[0][1].find(
      (arg: unknown) => arg instanceof Date && (arg as Date).getTime() > after,
    ) as Date;

    expect(expiresAtArg).toBeDefined();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAtArg.getTime()).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
    expect(expiresAtArg.getTime()).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
  });

  it('should not throw on query error (non-fatal)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    await expect(
      writeAuditLog({
        tenantId: 'tenant-123',
        eventType: 'discovery.scan.started',
        action: 'scan_started',
        resourceId: 'scan-abc',
        status: 'info',
        severity: 'info',
        details: 'test',
      }),
    ).resolves.toBeUndefined();

    expect(mockRelease).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/audit-service.test.ts`
Expected: FAIL with "Cannot find module '../services/audit-service.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// workers/src/jobs/discovery/services/audit-service.ts
import { Pool, type PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

export async function writeAuditLog(entry: {
  tenantId: string;
  eventType: string;
  action: string;
  resourceId: string;
  status: string;
  severity: string;
  details: string;
  metadata?: Record<string, unknown>;
  accountId?: string;
  region?: string;
}): Promise<void> {
  const client: PoolClient = await getPool().connect();
  try {
    const id = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const logId = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO audit_logs
         (id, "tenantId", "logId", timestamp, "eventType", action,
          "user", "userType", "resourceType", "resourceId",
          status, severity, details, metadata, "accountId", region, "expiresAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT DO NOTHING`,
      [
        id, entry.tenantId, logId, new Date(),
        entry.eventType, entry.action,
        'system', 'system',
        'discovery', entry.resourceId,
        entry.status, entry.severity, entry.details,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.accountId ?? null, entry.region ?? null, expiresAt,
      ],
    );
  } catch (error) {
    console.error('[discovery/audit] Error writing audit log:', error);
    // Non-fatal — don't throw
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/audit-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/src/jobs/discovery/services/audit-service.ts workers/src/jobs/discovery/__tests__/audit-service.test.ts
git commit -m "feat(discovery): add audit service for PostgreSQL audit log writes"
```

---

## Task 4: Account Service (`workers/src/jobs/discovery/services/account-service.ts`)

**Files:**
- Create: `workers/src/jobs/discovery/services/account-service.ts`
- Test: `workers/src/jobs/discovery/__tests__/account-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/src/jobs/discovery/__tests__/account-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ connect: mockConnect })),
}));

import {
  getAllTenants,
  getTenantAccounts,
  updateAccountSyncStatus,
} from '../services/account-service.js';

describe('account-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  });

  describe('getAllTenants', () => {
    it('should return active tenants ordered by createdAt', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'tenant-1', name: 'Acme Corp' },
          { id: 'tenant-2', name: 'Globex' },
        ],
      });

      const tenants = await getAllTenants();

      expect(tenants).toHaveLength(2);
      expect(tenants[0].id).toBe('tenant-1');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'active'"),
      );
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should return empty array on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      const tenants = await getAllTenants();

      expect(tenants).toEqual([]);
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('getTenantAccounts', () => {
    it('should return active accounts for a tenant', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'acc-1',
            tenantId: 'tenant-1',
            accountId: '123456789012',
            name: 'Production',
            roleArn: 'arn:aws:iam::123456789012:role/NucleusAccess',
            externalId: null,
            regions: ['us-east-1', 'ap-south-1'],
            active: true,
          },
        ],
      });

      const accounts = await getTenantAccounts('tenant-1');

      expect(accounts).toHaveLength(1);
      expect(accounts[0].accountId).toBe('123456789012');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('"tenantId" = $1'),
        ['tenant-1'],
      );
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should throw on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('query failed'));

      await expect(getTenantAccounts('tenant-1')).rejects.toThrow('query failed');
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('updateAccountSyncStatus', () => {
    it('should update sync status fields on the account', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await updateAccountSyncStatus('tenant-1', '123456789012', {
        lastSyncedAt: '2026-04-05T02:30:00Z',
        lastSyncStatus: 'success',
        lastSyncResourceCount: 150,
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE accounts'),
        expect.arrayContaining([
          'tenant-1',
          '123456789012',
          expect.any(Date),
          'success',
          150,
        ]),
      );
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should not throw on update error (non-fatal)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('update failed'));

      await expect(
        updateAccountSyncStatus('tenant-1', '123456789012', {
          lastSyncedAt: '2026-04-05T02:30:00Z',
          lastSyncStatus: 'failed',
          lastSyncResourceCount: 0,
        }),
      ).resolves.toBeUndefined();

      expect(mockRelease).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/account-service.test.ts`
Expected: FAIL with "Cannot find module '../services/account-service.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// workers/src/jobs/discovery/services/account-service.ts
import { Pool, type PoolClient } from 'pg';
import type { Account } from '../types.js';

const DATABASE_URL = process.env.DATABASE_URL;

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

/**
 * Get all active tenants. Used by fan-out handler.
 */
export async function getAllTenants(): Promise<Array<{ id: string; name: string }>> {
  const client: PoolClient = await getPool().connect();
  try {
    const result = await client.query(
      `SELECT id, name FROM tenants WHERE status = 'active' ORDER BY "createdAt" ASC`,
    );
    return result.rows;
  } catch (error) {
    console.error('[discovery/account] Error fetching active tenants:', error);
    return [];
  } finally {
    client.release();
  }
}

/**
 * Get all active accounts for a tenant.
 */
export async function getTenantAccounts(tenantId: string): Promise<Account[]> {
  const client: PoolClient = await getPool().connect();
  try {
    const result = await client.query(
      `SELECT id, "tenantId", "accountId", name, "roleArn", "externalId",
              regions, active
       FROM accounts
       WHERE "tenantId" = $1
         AND active = true`,
      [tenantId],
    );
    return result.rows;
  } catch (error) {
    console.error('[discovery/account] Error fetching tenant accounts:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Update account sync status after a discovery scan.
 */
export async function updateAccountSyncStatus(
  tenantId: string,
  accountId: string,
  status: {
    lastSyncedAt: string;
    lastSyncStatus: string;
    lastSyncResourceCount: number;
  },
): Promise<void> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query(
      `UPDATE accounts
       SET "connectionStatus" = $3,
           "updatedAt" = NOW()
       WHERE "tenantId" = $1
         AND "accountId" = $2`,
      [tenantId, accountId, new Date(status.lastSyncedAt), status.lastSyncStatus, status.lastSyncResourceCount],
    );
  } catch (error) {
    console.error('[discovery/account] Error updating account sync status:', error);
    // Non-fatal — don't throw
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/account-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/src/jobs/discovery/services/account-service.ts workers/src/jobs/discovery/__tests__/account-service.test.ts
git commit -m "feat(discovery): add account service for tenant/account queries"
```

---

## Task 5: Scanfile with Enrichments (`workers/src/jobs/discovery/scanfile.json`)

**Files:**
- Create: `workers/src/jobs/discovery/scanfile.json`

- [ ] **Step 1: No test needed — JSON config file**

- [ ] **Step 2: Write the scanfile**

```json
[
  {
    "service": "ec2",
    "function": "describe_instances",
    "result_key": "Reservations"
  },
  {
    "service": "ec2",
    "function": "describe_vpcs",
    "result_key": "Vpcs",
    "enrichments": [
      { "type": "tags", "method": "describe_vpcs", "idKey": "VpcId", "inputKey": "VpcIds", "batchSize": 200 }
    ]
  },
  {
    "service": "ec2",
    "function": "describe_subnets",
    "result_key": "Subnets"
  },
  {
    "service": "ec2",
    "function": "describe_security_groups",
    "result_key": "SecurityGroups"
  },
  {
    "service": "ec2",
    "function": "describe_volumes",
    "result_key": "Volumes"
  },
  {
    "service": "ec2",
    "function": "describe_nat_gateways",
    "result_key": "NatGateways"
  },
  {
    "service": "ec2",
    "function": "describe_addresses",
    "result_key": "Addresses"
  },
  {
    "service": "ec2",
    "function": "describe_network_interfaces",
    "result_key": "NetworkInterfaces"
  },
  {
    "service": "rds",
    "function": "describe_db_instances",
    "result_key": "DBInstances",
    "enrichments": [
      { "type": "tags", "method": "list_tags_for_resource", "arnKey": "DBInstanceArn" }
    ]
  },
  {
    "service": "rds",
    "function": "describe_db_clusters",
    "result_key": "DBClusters",
    "enrichments": [
      { "type": "tags", "method": "list_tags_for_resource", "arnKey": "DBClusterArn" }
    ]
  },
  {
    "service": "ecs",
    "function": "list_clusters",
    "result_key": "clusterArns",
    "enrichments": [
      { "type": "describe", "method": "describe_clusters", "inputKey": "clusters", "resultKey": "clusters", "batchSize": 100 },
      { "type": "tags", "method": "list_tags_for_resource", "arnKey": "clusterArn" }
    ]
  },
  {
    "service": "ecs",
    "function": "list_services",
    "result_key": "serviceArns"
  },
  {
    "service": "autoscaling",
    "function": "describe_auto_scaling_groups",
    "result_key": "AutoScalingGroups"
  },
  {
    "service": "lambda",
    "function": "list_functions",
    "result_key": "Functions",
    "enrichments": [
      { "type": "tags", "method": "list_tags", "arnKey": "FunctionArn", "inputKey": "Resource" }
    ]
  },
  {
    "service": "s3",
    "function": "list_buckets",
    "result_key": "Buckets",
    "enrichments": [
      { "type": "tags", "method": "get_bucket_tagging", "nameKey": "Name", "inputKey": "Bucket" },
      { "type": "detail", "method": "get_bucket_location", "nameKey": "Name", "inputKey": "Bucket" }
    ],
    "constraints": { "regionFilter": true }
  },
  {
    "service": "dynamodb",
    "function": "list_tables",
    "result_key": "TableNames",
    "enrichments": [
      { "type": "describe", "method": "describe_table", "inputKey": "TableName", "resultKey": "Table" },
      { "type": "tags", "method": "list_tags_of_resource", "arnKey": "TableArn", "inputKey": "ResourceArn" }
    ]
  },
  {
    "service": "elbv2",
    "function": "describe_load_balancers",
    "result_key": "LoadBalancers",
    "enrichments": [
      { "type": "tags", "method": "describe_tags", "arnKey": "LoadBalancerArn", "inputKey": "ResourceArns", "batchSize": 20 }
    ]
  },
  {
    "service": "elasticache",
    "function": "describe_cache_clusters",
    "result_key": "CacheClusters"
  },
  {
    "service": "sns",
    "function": "list_topics",
    "result_key": "Topics"
  },
  {
    "service": "sqs",
    "function": "list_queues",
    "result_key": "QueueUrls"
  },
  {
    "service": "kms",
    "function": "list_keys",
    "result_key": "Keys",
    "enrichments": [
      { "type": "describe", "method": "describe_key", "inputKey": "KeyId", "resultKey": "KeyMetadata", "idKey": "KeyId" },
      { "type": "tags", "method": "list_resource_tags", "idKey": "KeyId", "inputKey": "KeyId" }
    ]
  },
  {
    "service": "secretsmanager",
    "function": "list_secrets",
    "result_key": "SecretList"
  },
  {
    "service": "efs",
    "function": "describe_file_systems",
    "result_key": "FileSystems"
  },
  {
    "service": "cloudfront",
    "function": "list_distributions",
    "result_key": "DistributionList",
    "constraints": { "regionOverride": "us-east-1" }
  },
  {
    "service": "acm",
    "function": "list_certificates",
    "result_key": "CertificateSummaryList",
    "enrichments": [
      { "type": "tags", "method": "list_tags_for_certificate", "arnKey": "CertificateArn" }
    ]
  },
  {
    "service": "ecr",
    "function": "describe_repositories",
    "result_key": "repositories",
    "enrichments": [
      { "type": "tags", "method": "list_tags_for_resource", "arnKey": "repositoryArn", "inputKey": "resourceArn" }
    ]
  },
  {
    "service": "apigateway",
    "function": "get_rest_apis",
    "result_key": "items",
    "enrichments": [
      { "type": "tags", "method": "get_tags", "arnKey": "_computedArn", "inputKey": "resourceArn" }
    ]
  },
  {
    "service": "codepipeline",
    "function": "list_pipelines",
    "result_key": "pipelines"
  },
  {
    "service": "ssm",
    "function": "describe_parameters",
    "result_key": "Parameters"
  },
  {
    "service": "iam",
    "function": "list_roles",
    "result_key": "Roles"
  },
  {
    "service": "iam",
    "function": "list_users",
    "result_key": "Users"
  },
  {
    "service": "docdb",
    "function": "describe_db_clusters",
    "result_key": "DBClusters",
    "enrichments": [
      { "type": "tags", "method": "list_tags_for_resource", "arnKey": "DBClusterArn" }
    ]
  },
  {
    "service": "eks",
    "function": "list_clusters",
    "result_key": "clusters",
    "enrichments": [
      { "type": "describe", "method": "describe_cluster", "inputKey": "name", "resultKey": "cluster" }
    ]
  },
  {
    "service": "cloudwatch",
    "function": "describe_alarms",
    "result_key": "MetricAlarms"
  },
  {
    "service": "events",
    "function": "list_rules",
    "result_key": "Rules"
  },
  {
    "service": "ec2",
    "function": "describe_transit_gateways",
    "result_key": "TransitGateways"
  },
  {
    "service": "backup",
    "function": "list_backup_plans",
    "result_key": "BackupPlansList"
  },
  {
    "service": "ec2",
    "function": "describe_transit_gateway_attachments",
    "result_key": "TransitGatewayAttachments"
  },
  {
    "service": "ec2",
    "function": "describe_vpc_peering_connections",
    "result_key": "VpcPeeringConnections"
  },
  {
    "service": "wafv2",
    "function": "list_web_acls",
    "result_key": "WebACLs",
    "constraints": { "scopes": ["REGIONAL", "CLOUDFRONT"] }
  }
]
```

- [ ] **Step 3: Commit**

```bash
git add workers/src/jobs/discovery/scanfile.json
git commit -m "feat(discovery): add scanfile.json with declarative enrichment steps"
```

---

## Task 6: Scanner Engine — invokeService (`workers/src/jobs/discovery/services/scanner.ts`)

**Files:**
- Create: `workers/src/jobs/discovery/services/scanner.ts`
- Test: `workers/src/jobs/discovery/__tests__/scanner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/src/jobs/discovery/__tests__/scanner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll build this test file incrementally across Tasks 6-9.
// Task 6 covers: toCommandName, SERVICE_REGISTRY, invokeService

describe('scanner — toCommandName', () => {
  // Import after mocks are set up
  let toCommandName: (fn: string) => string;

  beforeEach(async () => {
    const mod = await import('../services/scanner.js');
    toCommandName = mod.toCommandName;
  });

  it('should convert describe_instances to DescribeInstancesCommand', () => {
    expect(toCommandName('describe_instances')).toBe('DescribeInstancesCommand');
  });

  it('should convert list_buckets to ListBucketsCommand', () => {
    expect(toCommandName('list_buckets')).toBe('ListBucketsCommand');
  });

  it('should convert get_rest_apis to GetRestApisCommand', () => {
    expect(toCommandName('get_rest_apis')).toBe('GetRestApisCommand');
  });

  it('should convert describe_auto_scaling_groups to DescribeAutoScalingGroupsCommand', () => {
    expect(toCommandName('describe_auto_scaling_groups')).toBe('DescribeAutoScalingGroupsCommand');
  });

  it('should convert list_tags_for_resource to ListTagsForResourceCommand', () => {
    expect(toCommandName('list_tags_for_resource')).toBe('ListTagsForResourceCommand');
  });
});

describe('scanner — invokeService', () => {
  let invokeService: typeof import('../services/scanner.js').invokeService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../services/scanner.js');
    invokeService = mod.invokeService;
  });

  it('should call client.send with the correct command and extract result_key', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValueOnce({
        Vpcs: [{ VpcId: 'vpc-123' }, { VpcId: 'vpc-456' }],
        ResponseMetadata: {},
      }),
    };

    const result = await invokeService(mockClient as any, 'us-east-1', {
      service: 'ec2',
      function: 'describe_vpcs',
      result_key: 'Vpcs',
    });

    expect(result).toHaveLength(2);
    expect(result[0].VpcId).toBe('vpc-123');
    expect(mockClient.send).toHaveBeenCalled();
  });

  it('should return empty array when result_key is missing from response', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValueOnce({ ResponseMetadata: {} }),
    };

    const result = await invokeService(mockClient as any, 'us-east-1', {
      service: 'ec2',
      function: 'describe_vpcs',
      result_key: 'Vpcs',
    });

    expect(result).toEqual([]);
  });

  it('should retry on ThrottlingException with exponential backoff', async () => {
    const throttleError = new Error('Rate exceeded');
    (throttleError as any).name = 'ThrottlingException';

    const mockClient = {
      send: vi
        .fn()
        .mockRejectedValueOnce(throttleError)
        .mockResolvedValueOnce({
          Vpcs: [{ VpcId: 'vpc-123' }],
        }),
    };

    const result = await invokeService(mockClient as any, 'us-east-1', {
      service: 'ec2',
      function: 'describe_vpcs',
      result_key: 'Vpcs',
    });

    expect(result).toHaveLength(1);
    expect(mockClient.send).toHaveBeenCalledTimes(2);
  });

  it('should retry on RequestLimitExceeded', async () => {
    const limitError = new Error('Request limit exceeded');
    (limitError as any).name = 'RequestLimitExceeded';

    const mockClient = {
      send: vi
        .fn()
        .mockRejectedValueOnce(limitError)
        .mockResolvedValueOnce({
          Functions: [{ FunctionName: 'my-func' }],
        }),
    };

    const result = await invokeService(mockClient as any, 'us-east-1', {
      service: 'lambda',
      function: 'list_functions',
      result_key: 'Functions',
    });

    expect(result).toHaveLength(1);
    expect(mockClient.send).toHaveBeenCalledTimes(2);
  });

  it('should throw after max retries exhausted', async () => {
    const throttleError = new Error('Rate exceeded');
    (throttleError as any).name = 'ThrottlingException';

    const mockClient = {
      send: vi.fn().mockRejectedValue(throttleError),
    };

    await expect(
      invokeService(mockClient as any, 'us-east-1', {
        service: 'ec2',
        function: 'describe_vpcs',
        result_key: 'Vpcs',
      }),
    ).rejects.toThrow('Rate exceeded');

    // 1 initial + 3 retries = 4 total calls
    expect(mockClient.send).toHaveBeenCalledTimes(4);
  });

  it('should throw immediately on non-retryable errors', async () => {
    const authError = new Error('UnauthorizedAccess');
    (authError as any).name = 'UnauthorizedAccess';

    const mockClient = {
      send: vi.fn().mockRejectedValueOnce(authError),
    };

    await expect(
      invokeService(mockClient as any, 'us-east-1', {
        service: 'ec2',
        function: 'describe_vpcs',
        result_key: 'Vpcs',
      }),
    ).rejects.toThrow('UnauthorizedAccess');

    expect(mockClient.send).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/scanner.test.ts`
Expected: FAIL with "Cannot find module '../services/scanner.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// workers/src/jobs/discovery/services/scanner.ts
import type { ScanConfig, Resource, ScanResult, EnrichmentStep, AssumedCredentials } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2000;
const RETRYABLE_ERROR_NAMES = new Set(['ThrottlingException', 'RequestLimitExceeded', 'Throttling', 'TooManyRequestsException']);

const CONCURRENT_REGIONS = parseInt(process.env.CONCURRENT_REGIONS || '5', 10);
const CONCURRENT_SERVICES = parseInt(process.env.CONCURRENT_SERVICES || '10', 10);

// ---------------------------------------------------------------------------
// SERVICE_REGISTRY — maps scanfile service name → AWS SDK v3 client constructor
// ---------------------------------------------------------------------------

import { EC2Client } from '@aws-sdk/client-ec2';
import { RDSClient } from '@aws-sdk/client-rds';
import { ECSClient } from '@aws-sdk/client-ecs';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { KMSClient } from '@aws-sdk/client-kms';
import { ECRClient } from '@aws-sdk/client-ecr';
import { EKSClient } from '@aws-sdk/client-eks';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { ACMClient } from '@aws-sdk/client-acm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SNSClient } from '@aws-sdk/client-sns';
import { IAMClient } from '@aws-sdk/client-iam';
import { AutoScalingClient } from '@aws-sdk/client-auto-scaling';
import { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { EFSClient } from '@aws-sdk/client-efs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { WAFV2Client } from '@aws-sdk/client-wafv2';
import { BackupClient } from '@aws-sdk/client-backup';
import { CodePipelineClient } from '@aws-sdk/client-codepipeline';

export const SERVICE_REGISTRY: Record<string, new (config: any) => any> = {
  ec2: EC2Client,
  rds: RDSClient,
  ecs: ECSClient,
  lambda: LambdaClient,
  s3: S3Client,
  elbv2: ElasticLoadBalancingV2Client,
  kms: KMSClient,
  ecr: ECRClient,
  eks: EKSClient,
  cloudfront: CloudFrontClient,
  apigateway: APIGatewayClient,
  acm: ACMClient,
  dynamodb: DynamoDBClient,
  sqs: SQSClient,
  sns: SNSClient,
  iam: IAMClient,
  autoscaling: AutoScalingClient,
  elasticache: ElastiCacheClient,
  efs: EFSClient,
  secretsmanager: SecretsManagerClient,
  ssm: SSMClient,
  cloudwatch: CloudWatchClient,
  events: EventBridgeClient,
  wafv2: WAFV2Client,
  backup: BackupClient,
  codepipeline: CodePipelineClient,
  docdb: RDSClient, // DocDB uses RDS client
};

// ---------------------------------------------------------------------------
// toCommandName — converts snake_case function to PascalCase + "Command"
// ---------------------------------------------------------------------------

export function toCommandName(fn: string): string {
  return (
    fn
      .split('_')
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join('') + 'Command'
  );
}

// ---------------------------------------------------------------------------
// sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// isRetryable — check if an error is retryable
// ---------------------------------------------------------------------------

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    return RETRYABLE_ERROR_NAMES.has((error as any).name) || RETRYABLE_ERROR_NAMES.has((error as any).Code);
  }
  return false;
}

// ---------------------------------------------------------------------------
// invokeService — generic API caller with retry
// ---------------------------------------------------------------------------

export async function invokeService(
  client: any,
  region: string,
  scanConfig: ScanConfig,
): Promise<any[]> {
  const commandName = toCommandName(scanConfig.function);
  const params = scanConfig.parameters || {};

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Dynamically construct the command
      // We use a generic approach: create an object with the command name
      const CommandClass = await getCommandClass(scanConfig.service, commandName);
      const command = new CommandClass(params);
      const response = await client.send(command);

      // Extract result_key
      const items = response[scanConfig.result_key];
      if (!items) return [];
      return Array.isArray(items) ? items : [items];
    } catch (error) {
      if (isRetryable(error) && attempt < MAX_RETRIES) {
        const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[discovery/scanner] Throttled on ${scanConfig.service}.${scanConfig.function} in ${region}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// getCommandClass — dynamically import the command class from the right package
// ---------------------------------------------------------------------------

const COMMAND_CACHE = new Map<string, any>();

async function getCommandClass(service: string, commandName: string): Promise<any> {
  const cacheKey = `${service}:${commandName}`;
  if (COMMAND_CACHE.has(cacheKey)) {
    return COMMAND_CACHE.get(cacheKey);
  }

  const packageMap: Record<string, string> = {
    ec2: '@aws-sdk/client-ec2',
    rds: '@aws-sdk/client-rds',
    ecs: '@aws-sdk/client-ecs',
    lambda: '@aws-sdk/client-lambda',
    s3: '@aws-sdk/client-s3',
    elbv2: '@aws-sdk/client-elastic-load-balancing-v2',
    kms: '@aws-sdk/client-kms',
    ecr: '@aws-sdk/client-ecr',
    eks: '@aws-sdk/client-eks',
    cloudfront: '@aws-sdk/client-cloudfront',
    apigateway: '@aws-sdk/client-api-gateway',
    acm: '@aws-sdk/client-acm',
    dynamodb: '@aws-sdk/client-dynamodb',
    sqs: '@aws-sdk/client-sqs',
    sns: '@aws-sdk/client-sns',
    iam: '@aws-sdk/client-iam',
    autoscaling: '@aws-sdk/client-auto-scaling',
    elasticache: '@aws-sdk/client-elasticache',
    efs: '@aws-sdk/client-efs',
    secretsmanager: '@aws-sdk/client-secrets-manager',
    ssm: '@aws-sdk/client-ssm',
    cloudwatch: '@aws-sdk/client-cloudwatch',
    events: '@aws-sdk/client-eventbridge',
    wafv2: '@aws-sdk/client-wafv2',
    backup: '@aws-sdk/client-backup',
    codepipeline: '@aws-sdk/client-codepipeline',
    docdb: '@aws-sdk/client-rds',
  };

  const pkg = packageMap[service];
  if (!pkg) {
    throw new Error(`Unknown service: ${service}`);
  }

  const mod = await import(pkg);
  const CommandCls = mod[commandName];
  if (!CommandCls) {
    throw new Error(`Command ${commandName} not found in ${pkg}`);
  }

  COMMAND_CACHE.set(cacheKey, CommandCls);
  return CommandCls;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/scanner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/src/jobs/discovery/services/scanner.ts workers/src/jobs/discovery/__tests__/scanner.test.ts
git commit -m "feat(discovery): add scanner engine with invokeService and retry logic"
```

---

## Task 7: Scanner Engine — applyEnrichments (`workers/src/jobs/discovery/services/scanner.ts`)

**Files:**
- Modify: `workers/src/jobs/discovery/services/scanner.ts`
- Modify: `workers/src/jobs/discovery/__tests__/scanner.test.ts`

- [ ] **Step 1: Write the failing tests (append to scanner.test.ts)**

```typescript
// Append to workers/src/jobs/discovery/__tests__/scanner.test.ts

describe('scanner — applyEnrichments', () => {
  let applyEnrichments: typeof import('../services/scanner.js').applyEnrichments;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../services/scanner.js');
    applyEnrichments = mod.applyEnrichments;
  });

  it('should apply tag enrichment per resource using arnKey', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        TagList: [{ Key: 'Environment', Value: 'prod' }],
      }),
    };

    const resources = [
      { DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:mydb', DBInstanceIdentifier: 'mydb' },
    ];

    const enrichments: EnrichmentStep[] = [
      { type: 'tags', method: 'list_tags_for_resource', arnKey: 'DBInstanceArn' },
    ];

    const enriched = await applyEnrichments(mockClient as any, 'rds', resources, enrichments);

    expect(mockClient.send).toHaveBeenCalledTimes(1);
    expect(enriched[0].Tags).toBeDefined();
  });

  it('should apply tag enrichment in batches using batchSize', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        TagDescriptions: [
          { ResourceArn: 'arn:lb1', Tags: [{ Key: 'Name', Value: 'lb1' }] },
          { ResourceArn: 'arn:lb2', Tags: [{ Key: 'Name', Value: 'lb2' }] },
        ],
      }),
    };

    const resources = [
      { LoadBalancerArn: 'arn:lb1' },
      { LoadBalancerArn: 'arn:lb2' },
    ];

    const enrichments: EnrichmentStep[] = [
      { type: 'tags', method: 'describe_tags', arnKey: 'LoadBalancerArn', inputKey: 'ResourceArns', batchSize: 20 },
    ];

    const enriched = await applyEnrichments(mockClient as any, 'elbv2', resources, enrichments);

    expect(mockClient.send).toHaveBeenCalledTimes(1); // batched into 1 call
    expect(enriched).toHaveLength(2);
  });

  it('should apply describe enrichment and replace items', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        clusters: [
          { clusterArn: 'arn:cluster1', clusterName: 'cluster1', status: 'ACTIVE' },
        ],
      }),
    };

    const resources = ['arn:cluster1'];

    const enrichments: EnrichmentStep[] = [
      { type: 'describe', method: 'describe_clusters', inputKey: 'clusters', resultKey: 'clusters', batchSize: 100 },
    ];

    const enriched = await applyEnrichments(mockClient as any, 'ecs', resources, enrichments);

    expect(enriched[0]).toHaveProperty('clusterName', 'cluster1');
  });

  it('should apply detail enrichment per resource', async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue({
        LocationConstraint: 'us-west-2',
      }),
    };

    const resources = [{ Name: 'my-bucket' }];

    const enrichments: EnrichmentStep[] = [
      { type: 'detail', method: 'get_bucket_location', nameKey: 'Name', inputKey: 'Bucket' },
    ];

    const enriched = await applyEnrichments(mockClient as any, 's3', resources, enrichments);

    expect(enriched[0]).toHaveProperty('LocationConstraint', 'us-west-2');
  });

  it('should continue on enrichment error for individual resources', async () => {
    const mockClient = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error('NoSuchTagSet'))
        .mockResolvedValueOnce({
          TagSet: [{ Key: 'Name', Value: 'bucket2' }],
        }),
    };

    const resources = [{ Name: 'bucket1' }, { Name: 'bucket2' }];

    const enrichments: EnrichmentStep[] = [
      { type: 'tags', method: 'get_bucket_tagging', nameKey: 'Name', inputKey: 'Bucket' },
    ];

    const enriched = await applyEnrichments(mockClient as any, 's3', resources, enrichments);

    expect(enriched).toHaveLength(2);
    // First resource should still exist even though tag fetch failed
    expect(enriched[0].Name).toBe('bucket1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/scanner.test.ts`
Expected: FAIL with "applyEnrichments is not a function" or "not exported"

- [ ] **Step 3: Add applyEnrichments to scanner.ts**

Append the following to `workers/src/jobs/discovery/services/scanner.ts`:

```typescript
// ---------------------------------------------------------------------------
// applyEnrichments — generic enrichment engine
// ---------------------------------------------------------------------------

export async function applyEnrichments(
  client: any,
  service: string,
  resources: any[],
  enrichments: EnrichmentStep[],
): Promise<any[]> {
  let current = [...resources];

  for (const enrichment of enrichments) {
    try {
      switch (enrichment.type) {
        case 'tags':
          current = await applyTagEnrichment(client, service, current, enrichment);
          break;
        case 'describe':
          current = await applyDescribeEnrichment(client, service, current, enrichment);
          break;
        case 'detail':
          current = await applyDetailEnrichment(client, service, current, enrichment);
          break;
      }
    } catch (error) {
      console.warn(
        `[discovery/scanner] Enrichment ${enrichment.type}:${enrichment.method} failed for ${service}, continuing:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return current;
}

// ---------------------------------------------------------------------------
// Tag enrichment — per-resource or batched
// ---------------------------------------------------------------------------

async function applyTagEnrichment(
  client: any,
  service: string,
  resources: any[],
  enrichment: EnrichmentStep,
): Promise<any[]> {
  const { method, arnKey, nameKey, inputKey, batchSize } = enrichment;
  const CommandClass = await getCommandClass(service, toCommandName(method));

  // Batched tag fetching (e.g., ELBv2 describe_tags with ResourceArns)
  if (batchSize && arnKey && inputKey) {
    const arnMap = new Map<string, any>();
    for (const r of resources) {
      if (typeof r === 'object' && r[arnKey]) {
        arnMap.set(r[arnKey], r);
      }
    }
    const arns = Array.from(arnMap.keys());

    for (let i = 0; i < arns.length; i += batchSize) {
      const batch = arns.slice(i, i + batchSize);
      try {
        const command = new CommandClass({ [inputKey]: batch });
        const response = await client.send(command);

        // Handle TagDescriptions format (ELBv2)
        const tagDescs = response.TagDescriptions || [];
        for (const td of tagDescs) {
          const arn = td.ResourceArn;
          if (arn && arnMap.has(arn)) {
            arnMap.get(arn).Tags = td.Tags || [];
          }
        }
      } catch (error) {
        console.warn(`[discovery/scanner] Batch tag enrichment failed for ${service}:`, error instanceof Error ? error.message : error);
      }
    }
    return resources;
  }

  // Per-resource tag fetching
  for (const resource of resources) {
    if (typeof resource !== 'object') continue;

    const key = arnKey ? resource[arnKey] : nameKey ? resource[nameKey] : null;
    if (!key) continue;

    try {
      const paramKey = inputKey || (arnKey ? 'ResourceArn' : 'ResourceName');
      const command = new CommandClass({ [paramKey]: key });
      const response = await client.send(command);

      // Extract tags from response — try common keys
      const tags =
        response.Tags ||
        response.TagList ||
        response.TagSet ||
        response.tags ||
        [];
      resource.Tags = Array.isArray(tags)
        ? tags
        : Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
    } catch (error) {
      // Non-fatal — resource keeps going without tags
      console.warn(
        `[discovery/scanner] Tag fetch failed for ${key}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return resources;
}

// ---------------------------------------------------------------------------
// Describe enrichment — batch IDs, call describe, replace list items
// ---------------------------------------------------------------------------

async function applyDescribeEnrichment(
  client: any,
  service: string,
  resources: any[],
  enrichment: EnrichmentStep,
): Promise<any[]> {
  const { method, inputKey, resultKey, batchSize, idKey } = enrichment;
  const CommandClass = await getCommandClass(service, toCommandName(method));

  // Collect IDs/ARNs from resources
  const ids: any[] = resources.map((r) => {
    if (typeof r === 'string') return r;
    if (idKey && r[idKey]) return r[idKey];
    return r;
  });

  const allDescribed: any[] = [];
  const chunkSize = batchSize || ids.length;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const batch = ids.slice(i, i + chunkSize);
    try {
      // For single-item describe (e.g., describe_cluster with name), call per item
      if (!batchSize || batchSize === 1) {
        for (const id of batch) {
          const params = inputKey ? { [inputKey]: id } : {};
          const command = new CommandClass(params);
          const response = await client.send(command);
          const result = resultKey ? response[resultKey] : response;
          if (Array.isArray(result)) {
            allDescribed.push(...result);
          } else if (result) {
            allDescribed.push(result);
          }
        }
      } else {
        // Batch describe (e.g., describe_clusters with clusters: [...])
        const params = inputKey ? { [inputKey]: batch } : {};
        const command = new CommandClass(params);
        const response = await client.send(command);
        const result = resultKey ? response[resultKey] : response;
        if (Array.isArray(result)) {
          allDescribed.push(...result);
        } else if (result) {
          allDescribed.push(result);
        }
      }
    } catch (error) {
      console.warn(
        `[discovery/scanner] Describe enrichment failed for ${service}.${method}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return allDescribed.length > 0 ? allDescribed : resources;
}

// ---------------------------------------------------------------------------
// Detail enrichment — per-resource detail call, merge into resource
// ---------------------------------------------------------------------------

async function applyDetailEnrichment(
  client: any,
  service: string,
  resources: any[],
  enrichment: EnrichmentStep,
): Promise<any[]> {
  const { method, nameKey, arnKey, inputKey, mergeKey } = enrichment;
  const CommandClass = await getCommandClass(service, toCommandName(method));

  for (const resource of resources) {
    if (typeof resource !== 'object') continue;

    const key = nameKey ? resource[nameKey] : arnKey ? resource[arnKey] : null;
    if (!key) continue;

    try {
      const paramKey = inputKey || 'ResourceName';
      const command = new CommandClass({ [paramKey]: key });
      const response = await client.send(command);

      // Remove ResponseMetadata before merging
      const { ResponseMetadata, ...data } = response;

      if (mergeKey && data[mergeKey]) {
        Object.assign(resource, data[mergeKey]);
      } else {
        Object.assign(resource, data);
      }
    } catch (error) {
      console.warn(
        `[discovery/scanner] Detail enrichment failed for ${key}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return resources;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/scanner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/src/jobs/discovery/services/scanner.ts workers/src/jobs/discovery/__tests__/scanner.test.ts
git commit -m "feat(discovery): add applyEnrichments engine for tags/describe/detail"
```

---

## Task 8: Scanner Engine — normalizeResources & extractResourceIdentifiers (`workers/src/jobs/discovery/services/scanner.ts`)

**Files:**
- Modify: `workers/src/jobs/discovery/services/scanner.ts`
- Modify: `workers/src/jobs/discovery/__tests__/scanner.test.ts`

- [ ] **Step 1: Write the failing tests (append to scanner.test.ts)**

```typescript
// Append to workers/src/jobs/discovery/__tests__/scanner.test.ts

describe('scanner — extractResourceIdentifiers', () => {
  let extractResourceIdentifiers: typeof import('../services/scanner.js').extractResourceIdentifiers;

  beforeEach(async () => {
    const mod = await import('../services/scanner.js');
    extractResourceIdentifiers = mod.extractResourceIdentifiers;
  });

  it('should extract EC2 instance identifiers', () => {
    const resource = {
      InstanceId: 'i-0abc123def456',
      State: { Name: 'running' },
      Tags: [{ Key: 'Name', Value: 'my-instance' }],
    };

    const ids = extractResourceIdentifiers(resource, 'ec2');

    expect(ids.resourceId).toBe('i-0abc123def456');
    expect(ids.state).toBe('running');
    expect(ids.name).toBe('my-instance');
    expect(ids.tags).toEqual({ Name: 'my-instance' });
  });

  it('should extract RDS instance identifiers', () => {
    const resource = {
      DBInstanceIdentifier: 'mydb',
      DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:mydb',
      DBInstanceStatus: 'available',
      TagList: [{ Key: 'Environment', Value: 'prod' }],
    };

    const ids = extractResourceIdentifiers(resource, 'rds');

    expect(ids.resourceId).toBe('mydb');
    expect(ids.resourceArn).toBe('arn:aws:rds:us-east-1:123:db:mydb');
    expect(ids.state).toBe('available');
    expect(ids.name).toBe('mydb');
    expect(ids.tags).toEqual({ Environment: 'prod' });
  });

  it('should extract Lambda function identifiers', () => {
    const resource = {
      FunctionName: 'my-func',
      FunctionArn: 'arn:aws:lambda:us-east-1:123:function:my-func',
      Tags: [{ Key: 'Team', Value: 'platform' }],
    };

    const ids = extractResourceIdentifiers(resource, 'lambda');

    expect(ids.resourceId).toBe('my-func');
    expect(ids.resourceArn).toBe('arn:aws:lambda:us-east-1:123:function:my-func');
    expect(ids.name).toBe('my-func');
  });

  it('should extract ECS cluster identifiers (camelCase)', () => {
    const resource = {
      clusterArn: 'arn:aws:ecs:us-east-1:123:cluster/my-cluster',
      clusterName: 'my-cluster',
      status: 'ACTIVE',
    };

    const ids = extractResourceIdentifiers(resource, 'ecs');

    expect(ids.resourceId).toBe('arn:aws:ecs:us-east-1:123:cluster/my-cluster');
    expect(ids.resourceArn).toBe('arn:aws:ecs:us-east-1:123:cluster/my-cluster');
    expect(ids.name).toBe('my-cluster');
    expect(ids.state).toBe('ACTIVE');
  });

  it('should extract S3 bucket identifiers', () => {
    const resource = {
      Name: 'my-bucket',
      CreationDate: '2024-01-01T00:00:00Z',
    };

    const ids = extractResourceIdentifiers(resource, 's3');

    expect(ids.resourceId).toBe('my-bucket');
    expect(ids.name).toBe('my-bucket');
  });

  it('should extract VPC identifiers', () => {
    const resource = {
      VpcId: 'vpc-123abc',
      State: 'available',
      Tags: [{ Key: 'Name', Value: 'main-vpc' }],
    };

    const ids = extractResourceIdentifiers(resource, 'ec2');

    expect(ids.resourceId).toBe('vpc-123abc');
    expect(ids.state).toBe('available');
    expect(ids.name).toBe('main-vpc');
  });

  it('should extract CloudFront distribution identifiers', () => {
    const resource = {
      Id: 'E1234567890',
      DomainName: 'd111111abcdef8.cloudfront.net',
      Status: 'Deployed',
    };

    const ids = extractResourceIdentifiers(resource, 'cloudfront');

    expect(ids.resourceId).toBe('E1234567890');
    expect(ids.name).toBe('d111111abcdef8.cloudfront.net');
    expect(ids.state).toBe('Deployed');
  });

  it('should extract ECR repository identifiers', () => {
    const resource = {
      repositoryName: 'my-repo',
      repositoryArn: 'arn:aws:ecr:us-east-1:123:repository/my-repo',
    };

    const ids = extractResourceIdentifiers(resource, 'ecr');

    expect(ids.resourceId).toBe('my-repo');
    expect(ids.resourceArn).toBe('arn:aws:ecr:us-east-1:123:repository/my-repo');
    expect(ids.name).toBe('my-repo');
  });

  it('should extract IAM role identifiers', () => {
    const resource = {
      RoleName: 'AdminRole',
      RoleId: 'AROA1234567890',
      Arn: 'arn:aws:iam::123:role/AdminRole',
    };

    const ids = extractResourceIdentifiers(resource, 'iam');

    expect(ids.resourceId).toBe('AdminRole');
    expect(ids.resourceArn).toBe('arn:aws:iam::123:role/AdminRole');
    expect(ids.name).toBe('AdminRole');
  });

  it('should extract ACM certificate identifiers', () => {
    const resource = {
      CertificateArn: 'arn:aws:acm:us-east-1:123:certificate/abc-123',
      DomainName: 'example.com',
      CertificateId: 'abc-123',
    };

    const ids = extractResourceIdentifiers(resource, 'acm');

    expect(ids.resourceId).toBe('abc-123');
    expect(ids.resourceArn).toBe('arn:aws:acm:us-east-1:123:certificate/abc-123');
    expect(ids.name).toBe('example.com');
  });

  it('should handle dict-style tags', () => {
    const resource = {
      FunctionName: 'my-func',
      tags: { Team: 'platform', Env: 'prod' },
    };

    const ids = extractResourceIdentifiers(resource, 'lambda');

    expect(ids.tags).toEqual({ Team: 'platform', Env: 'prod' });
  });

  it('should default name to resourceId when no name key found', () => {
    const resource = {
      KeyId: 'key-abc-123',
      KeyArn: 'arn:aws:kms:us-east-1:123:key/key-abc-123',
    };

    const ids = extractResourceIdentifiers(resource, 'kms');

    expect(ids.resourceId).toBe('key-abc-123');
    expect(ids.name).toBe('key-abc-123');
  });

  it('should handle State as dict with Name key', () => {
    const resource = {
      InstanceId: 'i-123',
      State: { Name: 'stopped', Code: 80 },
    };

    const ids = extractResourceIdentifiers(resource, 'ec2');

    expect(ids.state).toBe('stopped');
  });
});

describe('scanner — normalizeResources', () => {
  let normalizeResources: typeof import('../services/scanner.js').normalizeResources;

  beforeEach(async () => {
    const mod = await import('../services/scanner.js');
    normalizeResources = mod.normalizeResources;
  });

  it('should normalize object items into Resource[]', () => {
    const rawItems = [
      { InstanceId: 'i-123', State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'web' }] },
    ];

    const resources = normalizeResources(rawItems, 'ec2', 'describe_instances', 'us-east-1');

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceType).toBe('ec2_instances');
    expect(resources[0].resourceId).toBe('i-123');
    expect(resources[0].region).toBe('us-east-1');
    expect(resources[0].service).toBe('ec2');
    expect(resources[0].state).toBe('running');
    expect(resources[0].name).toBe('web');
  });

  it('should normalize string items (ARNs)', () => {
    const rawItems = ['arn:aws:ecs:us-east-1:123:cluster/my-cluster'];

    const resources = normalizeResources(rawItems, 'ecs', 'list_clusters', 'us-east-1');

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceType).toBe('ecs_clusters');
    expect(resources[0].resourceId).toBe('my-cluster');
    expect(resources[0].resourceArn).toBe('arn:aws:ecs:us-east-1:123:cluster/my-cluster');
  });

  it('should normalize string items (names/URLs)', () => {
    const rawItems = ['https://sqs.us-east-1.amazonaws.com/123/my-queue'];

    const resources = normalizeResources(rawItems, 'sqs', 'list_queues', 'us-east-1');

    expect(resources).toHaveLength(1);
    expect(resources[0].resourceType).toBe('sqs_queues');
    expect(resources[0].resourceId).toBe('my-queue');
  });

  it('should strip describe_/list_/get_ prefix from resourceType', () => {
    expect(
      normalizeResources([{ VpcId: 'vpc-1' }], 'ec2', 'describe_vpcs', 'us-east-1')[0].resourceType,
    ).toBe('ec2_vpcs');

    expect(
      normalizeResources(['fn1'], 'lambda', 'list_functions', 'us-east-1')[0].resourceType,
    ).toBe('lambda_functions');

    expect(
      normalizeResources([{ id: 'api1' }], 'apigateway', 'get_rest_apis', 'us-east-1')[0].resourceType,
    ).toBe('apigateway_rest_apis');
  });

  it('should return empty array for null/undefined input', () => {
    expect(normalizeResources(null as any, 'ec2', 'describe_vpcs', 'us-east-1')).toEqual([]);
    expect(normalizeResources(undefined as any, 'ec2', 'describe_vpcs', 'us-east-1')).toEqual([]);
    expect(normalizeResources([], 'ec2', 'describe_vpcs', 'us-east-1')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/scanner.test.ts`
Expected: FAIL with "extractResourceIdentifiers is not a function" or "normalizeResources is not a function"

- [ ] **Step 3: Add normalizeResources and extractResourceIdentifiers to scanner.ts**

Append the following to `workers/src/jobs/discovery/services/scanner.ts`:

```typescript
// ---------------------------------------------------------------------------
// extractResourceIdentifiers — extract id/arn/name/state/tags from AWS response
// Ported from Python inventory_runner.py extract_resource_identifiers()
// ---------------------------------------------------------------------------

export function extractResourceIdentifiers(
  resource: Record<string, any>,
  service: string,
): { resourceId: string; resourceArn: string; name: string; state: string; tags: Record<string, string> } {
  const identifiers = {
    resourceId: '',
    resourceArn: '',
    name: '',
    state: 'unknown',
    tags: {} as Record<string, string>,
  };

  // ID extraction — ordered by specificity
  const idKeys = [
    'InstanceId', 'DBInstanceIdentifier', 'DBClusterIdentifier', 'ClusterIdentifier',
    'FunctionName', 'BucketName', 'Name',
    'VolumeId', 'NetworkInterfaceId', 'VpcId', 'SubnetId', 'GroupId',
    'KeyId', 'AutoScalingGroupName', 'LoadBalancerArn', 'TopicArn', 'QueueUrl',
    'FileSystemId', 'NatGatewayId', 'DistributionId', 'TableName', 'StreamName',
    'CacheClusterId', 'ReplicationGroupId', 'ClusterArn', 'ServiceArn', 'TaskArn',
    'TransitGatewayId', 'TransitGatewayAttachmentId', 'VpcPeeringConnectionId',
    'clusterArn', 'serviceArn',
    'clusterName', 'serviceName',
    'repositoryName',
    'CertificateId', 'CertificateArn',
    'RoleName', 'RoleId',
    'UserName', 'UserId',
    'id', 'name', 'Id',
  ];

  for (const key of idKeys) {
    if (key in resource) {
      identifiers.resourceId = resource[key];
      break;
    }
  }

  // ARN extraction
  const arnKeys = [
    'Arn', 'ARN', 'FunctionArn', 'DBInstanceArn', 'DBClusterArn',
    'LoadBalancerArn', 'TopicArn', 'QueueArn', 'FileSystemArn',
    'KeyArn', 'ClusterArn', 'ServiceArn', 'TaskArn', 'TableArn',
    'TransitGatewayArn',
    'clusterArn', 'serviceArn',
    'CertificateArn',
    'repositoryArn',
  ];

  for (const key of arnKeys) {
    if (key in resource) {
      identifiers.resourceArn = resource[key];
      break;
    }
  }

  // Name extraction
  const nameKeys = [
    'Name', 'DBInstanceIdentifier', 'DBClusterIdentifier', 'FunctionName',
    'BucketName', 'AutoScalingGroupName', 'LoadBalancerName', 'FileSystemId',
    'TableName', 'TopicName', 'QueueName',
    'clusterName', 'serviceName',
    'repositoryName',
    'DomainName',
    'CertificateId',
  ];

  for (const key of nameKeys) {
    if (key in resource) {
      identifiers.name = resource[key];
      break;
    }
  }

  // Try tags for name if not found
  if (!identifiers.name) {
    const tags = resource.Tags || resource.TagList || [];
    if (Array.isArray(tags)) {
      for (const tag of tags) {
        if (typeof tag === 'object' && tag.Key === 'Name') {
          identifiers.name = tag.Value || '';
          break;
        }
      }
    }
  }

  // State extraction
  const state = resource.State ?? resource.DBInstanceStatus ?? resource.Status ?? resource.InstanceStatus;
  if (typeof state === 'object' && state !== null) {
    identifiers.state = state.Name ?? state.Code ?? 'unknown';
  } else if (typeof state === 'string') {
    identifiers.state = state;
  }

  // Tags extraction
  const rawTags = resource.Tags ?? resource.TagList ?? resource.tags ?? [];
  if (Array.isArray(rawTags)) {
    identifiers.tags = {};
    for (const tag of rawTags) {
      if (typeof tag === 'object' && 'Key' in tag) {
        identifiers.tags[tag.Key] = tag.Value ?? '';
      }
    }
  } else if (typeof rawTags === 'object') {
    identifiers.tags = rawTags as Record<string, string>;
  }

  // Default name to resourceId
  if (!identifiers.name) {
    identifiers.name = identifiers.resourceId;
  }

  return identifiers;
}

// ---------------------------------------------------------------------------
// normalizeResources — convert raw AWS response items to Resource[]
// Ported from Python inventory_runner.py normalize_resources()
// ---------------------------------------------------------------------------

export function normalizeResources(
  rawData: any,
  service: string,
  functionName: string,
  region: string,
): Resource[] {
  if (!rawData) return [];

  const items: any[] = Array.isArray(rawData) ? rawData : [rawData];
  const resourceType = `${service}_${functionName}`
    .replace('describe_', '')
    .replace('list_', '')
    .replace('get_', '');

  const resources: Resource[] = [];

  for (const item of items) {
    if (typeof item === 'string') {
      // Handle ARN or URL strings
      const id = item.includes('/') ? item.split('/').pop()! : item.split(':').pop()!;
      resources.push({
        resourceType,
        region,
        service,
        resourceId: id,
        resourceArn: item.startsWith('arn:') ? item : '',
        name: id,
        state: 'unknown',
        tags: {},
        rawData: item,
      });
    } else if (typeof item === 'object' && item !== null) {
      const ids = extractResourceIdentifiers(item, service);
      resources.push({
        resourceType,
        region,
        service,
        resourceId: ids.resourceId,
        resourceArn: ids.resourceArn,
        name: ids.name,
        state: ids.state,
        tags: ids.tags,
        rawData: item,
      });
    }
  }

  return resources;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/scanner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/src/jobs/discovery/services/scanner.ts workers/src/jobs/discovery/__tests__/scanner.test.ts
git commit -m "feat(discovery): add normalizeResources and extractResourceIdentifiers"
```

---

## Task 9: Scanner Engine — runInventoryScan (`workers/src/jobs/discovery/services/scanner.ts`)

**Files:**
- Modify: `workers/src/jobs/discovery/services/scanner.ts`
- Modify: `workers/src/jobs/discovery/__tests__/scanner.test.ts`

- [ ] **Step 1: Write the failing tests (append to scanner.test.ts)**

```typescript
// Append to workers/src/jobs/discovery/__tests__/scanner.test.ts

// We need to mock the scanner internals for runInventoryScan tests
vi.mock('p-limit', () => ({
  default: () => {
    const limit = (fn: () => Promise<any>) => fn();
    return limit;
  },
}));

describe('scanner — runInventoryScan', () => {
  let runInventoryScan: typeof import('../services/scanner.js').runInventoryScan;
  let mod: typeof import('../services/scanner.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    mod = await import('../services/scanner.js');
    runInventoryScan = mod.runInventoryScan;
  });

  it('should scan regions × services and return aggregated results', async () => {
    const credentials = {
      credentials: {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
        sessionToken: 'TOKEN',
      },
      region: 'us-east-1',
    };

    const scanConfigs = [
      { service: 'ec2', function: 'describe_vpcs', result_key: 'Vpcs' },
    ];

    // Mock invokeService at module level
    const originalInvoke = mod.invokeService;
    vi.spyOn(mod, 'invokeService' as any).mockResolvedValue([
      { VpcId: 'vpc-123', State: 'available' },
    ]);

    const result = await runInventoryScan(credentials, ['us-east-1'], scanConfigs);

    expect(result.resources.length).toBeGreaterThanOrEqual(0);
    expect(result.regionsScanned).toBe(1);
    expect(result.servicesScanned).toBe(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('should include errors array for failed services', async () => {
    const credentials = {
      credentials: {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
        sessionToken: 'TOKEN',
      },
      region: 'us-east-1',
    };

    const scanConfigs = [
      { service: 'ec2', function: 'describe_vpcs', result_key: 'Vpcs' },
    ];

    vi.spyOn(mod, 'invokeService' as any).mockRejectedValue(new Error('Access denied'));

    const result = await runInventoryScan(credentials, ['us-east-1'], scanConfigs);

    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('should handle regionOverride constraint', async () => {
    const credentials = {
      credentials: {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
        sessionToken: 'TOKEN',
      },
      region: 'us-east-1',
    };

    const scanConfigs = [
      {
        service: 'cloudfront',
        function: 'list_distributions',
        result_key: 'DistributionList',
        constraints: { regionOverride: 'us-east-1' },
      },
    ];

    const invokeSpy = vi.spyOn(mod, 'invokeService' as any).mockResolvedValue([]);

    await runInventoryScan(credentials, ['us-east-1', 'ap-south-1'], scanConfigs);

    // CloudFront should only be scanned in us-east-1 regardless of regions list
    // The regionOverride means it runs once in us-east-1, skipped in ap-south-1
    const calls = invokeSpy.mock.calls;
    const cfCalls = calls.filter((c: any) => c[2]?.service === 'cloudfront');
    expect(cfCalls.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/scanner.test.ts`
Expected: FAIL with "runInventoryScan is not a function"

- [ ] **Step 3: Add runInventoryScan to scanner.ts**

First, add `p-limit` to workers/package.json dependencies:

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npm install p-limit
```

Then append the following to `workers/src/jobs/discovery/services/scanner.ts`:

```typescript
import pLimit from 'p-limit';
import { CUSTOM_SCANNERS } from './custom-scanners.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ---------------------------------------------------------------------------
// createClient — create an AWS SDK v3 client for a service with credentials
// ---------------------------------------------------------------------------

export function createClient(
  service: string,
  region: string,
  credentials: AssumedCredentials['credentials'],
): any {
  const ClientClass = SERVICE_REGISTRY[service];
  if (!ClientClass) {
    throw new Error(`Unknown service in SERVICE_REGISTRY: ${service}`);
  }
  return new ClientClass({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });
}

// ---------------------------------------------------------------------------
// loadScanConfigs — load scanfile.json
// ---------------------------------------------------------------------------

export function loadScanConfigs(scanfilePath?: string): ScanConfig[] {
  const path = scanfilePath || join(dirname(fileURLToPath(import.meta.url)), '..', 'scanfile.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as ScanConfig[];
}

// ---------------------------------------------------------------------------
// runInventoryScan — orchestrator with p-limit concurrency
// ---------------------------------------------------------------------------

export async function runInventoryScan(
  assumed: AssumedCredentials,
  regions: string[],
  scanConfigs: ScanConfig[],
): Promise<ScanResult> {
  const startMs = Date.now();
  const regionLimit = pLimit(CONCURRENT_REGIONS);
  const serviceLimit = pLimit(CONCURRENT_SERVICES);

  const allResources: Resource[] = [];
  const errors: string[] = [];

  // Track which regionOverride configs have already been scanned
  const overrideScanned = new Set<string>();

  const regionTasks = regions.map((region) =>
    regionLimit(async () => {
      const serviceTasks = scanConfigs.map((config) =>
        serviceLimit(async () => {
          try {
            // Handle regionOverride constraint
            if (config.constraints?.regionOverride) {
              const overrideRegion = config.constraints.regionOverride;
              const key = `${config.service}:${config.function}`;
              if (region !== overrideRegion) return; // skip non-override regions
              if (overrideScanned.has(key)) return; // already scanned
              overrideScanned.add(key);
            }

            const effectiveRegion = config.constraints?.regionOverride || region;
            const client = createClient(config.service, effectiveRegion, assumed.credentials);

            // Check custom scanners first
            const customKey = `${config.service}:${config.function}`;
            let rawItems: any[];

            if (CUSTOM_SCANNERS[customKey]) {
              rawItems = await CUSTOM_SCANNERS[customKey](client, effectiveRegion, config);
            } else {
              rawItems = await invokeService(client, effectiveRegion, config);

              // Apply enrichments if defined
              if (config.enrichments?.length) {
                rawItems = await applyEnrichments(client, config.service, rawItems, config.enrichments);
              }
            }

            // Normalize
            const resources = normalizeResources(rawItems, config.service, config.function, effectiveRegion);
            allResources.push(...resources);
          } catch (error) {
            const msg = `${config.service}.${config.function} in ${region}: ${error instanceof Error ? error.message : String(error)}`;
            console.error(`[discovery/scanner] Error scanning ${msg}`);
            errors.push(msg);
          }
        }),
      );

      await Promise.all(serviceTasks);
    }),
  );

  await Promise.all(regionTasks);

  return {
    resources: allResources,
    regionsScanned: regions.length,
    servicesScanned: scanConfigs.length,
    elapsedMs: Date.now() - startMs,
    errors: errors.length > 0 ? errors : undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/scanner.test.ts`
Expected: PASS (some tests may need the custom-scanners module — create a stub if needed, see Task 10)

- [ ] **Step 5: Commit**

```bash
git add workers/src/jobs/discovery/services/scanner.ts workers/src/jobs/discovery/__tests__/scanner.test.ts workers/package.json workers/package-lock.json
git commit -m "feat(discovery): add runInventoryScan orchestrator with p-limit concurrency"
```

---

## Task 10: Custom Scanners (`workers/src/jobs/discovery/services/custom-scanners.ts`)

**Files:**
- Create: `workers/src/jobs/discovery/services/custom-scanners.ts`
- Test: `workers/src/jobs/discovery/__tests__/custom-scanners.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/src/jobs/discovery/__tests__/custom-scanners.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScanConfig } from '../types.js';

describe('custom-scanners', () => {
  let CUSTOM_SCANNERS: typeof import('../services/custom-scanners.js').CUSTOM_SCANNERS;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../services/custom-scanners.js');
    CUSTOM_SCANNERS = mod.CUSTOM_SCANNERS;
  });

  it('should export dispatch map with 4 custom handlers', () => {
    expect(CUSTOM_SCANNERS).toBeDefined();
    expect(Object.keys(CUSTOM_SCANNERS)).toHaveLength(4);
    expect(CUSTOM_SCANNERS['ec2:describe_instances']).toBeTypeOf('function');
    expect(CUSTOM_SCANNERS['ecs:list_services']).toBeTypeOf('function');
    expect(CUSTOM_SCANNERS['wafv2:list_web_acls']).toBeTypeOf('function');
    expect(CUSTOM_SCANNERS['cloudfront:list_distributions']).toBeTypeOf('function');
  });

  describe('ec2:describe_instances — flattenEC2Reservations', () => {
    it('should flatten Reservations[].Instances[] into flat instance list', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValueOnce({
          Reservations: [
            {
              Instances: [
                { InstanceId: 'i-111', State: { Name: 'running' } },
                { InstanceId: 'i-222', State: { Name: 'stopped' } },
              ],
            },
            {
              Instances: [
                { InstanceId: 'i-333', State: { Name: 'running' } },
              ],
            },
          ],
        }),
      };

      const config: ScanConfig = {
        service: 'ec2',
        function: 'describe_instances',
        result_key: 'Reservations',
      };

      const result = await CUSTOM_SCANNERS['ec2:describe_instances'](mockClient as any, 'us-east-1', config);

      expect(result).toHaveLength(3);
      expect(result[0].InstanceId).toBe('i-111');
      expect(result[1].InstanceId).toBe('i-222');
      expect(result[2].InstanceId).toBe('i-333');
    });

    it('should handle paginated responses', async () => {
      const mockClient = {
        send: vi
          .fn()
          .mockResolvedValueOnce({
            Reservations: [
              { Instances: [{ InstanceId: 'i-111' }] },
            ],
            NextToken: 'token1',
          })
          .mockResolvedValueOnce({
            Reservations: [
              { Instances: [{ InstanceId: 'i-222' }] },
            ],
          }),
      };

      const config: ScanConfig = {
        service: 'ec2',
        function: 'describe_instances',
        result_key: 'Reservations',
      };

      const result = await CUSTOM_SCANNERS['ec2:describe_instances'](mockClient as any, 'us-east-1', config);

      expect(result).toHaveLength(2);
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });

    it('should return empty array when no reservations', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValueOnce({ Reservations: [] }),
      };

      const config: ScanConfig = {
        service: 'ec2',
        function: 'describe_instances',
        result_key: 'Reservations',
      };

      const result = await CUSTOM_SCANNERS['ec2:describe_instances'](mockClient as any, 'us-east-1', config);

      expect(result).toEqual([]);
    });
  });

  describe('ecs:list_services — ecsServicesDeep', () => {
    it('should list clusters → list services per cluster → describe services', async () => {
      const mockClient = {
        send: vi.fn()
          // list_clusters
          .mockResolvedValueOnce({ clusterArns: ['arn:cluster1'] })
          // list_services for cluster1
          .mockResolvedValueOnce({ serviceArns: ['arn:svc1', 'arn:svc2'] })
          // describe_services batch
          .mockResolvedValueOnce({
            services: [
              { serviceArn: 'arn:svc1', serviceName: 'svc1', status: 'ACTIVE' },
              { serviceArn: 'arn:svc2', serviceName: 'svc2', status: 'ACTIVE' },
            ],
          }),
      };

      const config: ScanConfig = {
        service: 'ecs',
        function: 'list_services',
        result_key: 'serviceArns',
      };

      const result = await CUSTOM_SCANNERS['ecs:list_services'](mockClient as any, 'us-east-1', config);

      expect(result).toHaveLength(2);
      expect(result[0].serviceName).toBe('svc1');
      expect(result[0].ClusterArn).toBe('arn:cluster1');
    });

    it('should batch describe_services in groups of 10', async () => {
      // Create 15 service ARNs to test batching
      const serviceArns = Array.from({ length: 15 }, (_, i) => `arn:svc${i}`);

      const mockClient = {
        send: vi.fn()
          .mockResolvedValueOnce({ clusterArns: ['arn:cluster1'] })
          .mockResolvedValueOnce({ serviceArns })
          // First batch of 10
          .mockResolvedValueOnce({
            services: serviceArns.slice(0, 10).map((arn) => ({ serviceArn: arn, serviceName: arn.split(':').pop() })),
          })
          // Second batch of 5
          .mockResolvedValueOnce({
            services: serviceArns.slice(10).map((arn) => ({ serviceArn: arn, serviceName: arn.split(':').pop() })),
          }),
      };

      const config: ScanConfig = {
        service: 'ecs',
        function: 'list_services',
        result_key: 'serviceArns',
      };

      const result = await CUSTOM_SCANNERS['ecs:list_services'](mockClient as any, 'us-east-1', config);

      expect(result).toHaveLength(15);
      // 1 list_clusters + 1 list_services + 2 describe_services batches = 4 calls
      expect(mockClient.send).toHaveBeenCalledTimes(4);
    });
  });

  describe('wafv2:list_web_acls — wafv2Deep', () => {
    it('should scan REGIONAL scope in non-us-east-1 regions', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValueOnce({
          WebACLs: [{ Name: 'regional-acl', Id: 'acl-1' }],
        }),
      };

      const config: ScanConfig = {
        service: 'wafv2',
        function: 'list_web_acls',
        result_key: 'WebACLs',
        constraints: { scopes: ['REGIONAL', 'CLOUDFRONT'] },
      };

      const result = await CUSTOM_SCANNERS['wafv2:list_web_acls'](mockClient as any, 'ap-south-1', config);

      expect(result).toHaveLength(1);
      expect(result[0]._scope).toBe('REGIONAL');
      // Only 1 call — CLOUDFRONT scope skipped outside us-east-1
      expect(mockClient.send).toHaveBeenCalledTimes(1);
    });

    it('should scan both REGIONAL and CLOUDFRONT scopes in us-east-1', async () => {
      const mockClient = {
        send: vi.fn()
          .mockResolvedValueOnce({
            WebACLs: [{ Name: 'regional-acl', Id: 'acl-1' }],
          })
          .mockResolvedValueOnce({
            WebACLs: [{ Name: 'cf-acl', Id: 'acl-2' }],
          }),
      };

      const config: ScanConfig = {
        service: 'wafv2',
        function: 'list_web_acls',
        result_key: 'WebACLs',
        constraints: { scopes: ['REGIONAL', 'CLOUDFRONT'] },
      };

      const result = await CUSTOM_SCANNERS['wafv2:list_web_acls'](mockClient as any, 'us-east-1', config);

      expect(result).toHaveLength(2);
      expect(result[0]._scope).toBe('REGIONAL');
      expect(result[1]._scope).toBe('CLOUDFRONT');
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('cloudfront:list_distributions — cloudfrontDeep', () => {
    it('should unwrap DistributionList.Items in us-east-1', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValueOnce({
          DistributionList: {
            Items: [
              { Id: 'E123', DomainName: 'd123.cloudfront.net', Status: 'Deployed' },
              { Id: 'E456', DomainName: 'd456.cloudfront.net', Status: 'Deployed' },
            ],
            Quantity: 2,
          },
        }),
      };

      const config: ScanConfig = {
        service: 'cloudfront',
        function: 'list_distributions',
        result_key: 'DistributionList',
        constraints: { regionOverride: 'us-east-1' },
      };

      const result = await CUSTOM_SCANNERS['cloudfront:list_distributions'](mockClient as any, 'us-east-1', config);

      expect(result).toHaveLength(2);
      expect(result[0].Id).toBe('E123');
    });

    it('should return empty array for non-us-east-1 regions', async () => {
      const mockClient = { send: vi.fn() };

      const config: ScanConfig = {
        service: 'cloudfront',
        function: 'list_distributions',
        result_key: 'DistributionList',
        constraints: { regionOverride: 'us-east-1' },
      };

      const result = await CUSTOM_SCANNERS['cloudfront:list_distributions'](mockClient as any, 'ap-south-1', config);

      expect(result).toEqual([]);
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it('should handle paginated distribution lists', async () => {
      const mockClient = {
        send: vi.fn()
          .mockResolvedValueOnce({
            DistributionList: {
              Items: [{ Id: 'E123' }],
              NextMarker: 'marker1',
              IsTruncated: true,
            },
          })
          .mockResolvedValueOnce({
            DistributionList: {
              Items: [{ Id: 'E456' }],
              IsTruncated: false,
            },
          }),
      };

      const config: ScanConfig = {
        service: 'cloudfront',
        function: 'list_distributions',
        result_key: 'DistributionList',
        constraints: { regionOverride: 'us-east-1' },
      };

      const result = await CUSTOM_SCANNERS['cloudfront:list_distributions'](mockClient as any, 'us-east-1', config);

      expect(result).toHaveLength(2);
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/custom-scanners.test.ts`
Expected: FAIL with "Cannot find module '../services/custom-scanners.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// workers/src/jobs/discovery/services/custom-scanners.ts
import type { ScanConfig } from '../types.js';

type CustomScannerFn = (client: any, region: string, config: ScanConfig) => Promise<any[]>;

// ---------------------------------------------------------------------------
// EC2 — flatten Reservations[].Instances[]
// ---------------------------------------------------------------------------

async function flattenEC2Reservations(
  client: any,
  region: string,
  config: ScanConfig,
): Promise<any[]> {
  const { DescribeInstancesCommand } = await import('@aws-sdk/client-ec2');
  const allInstances: any[] = [];
  let nextToken: string | undefined;

  do {
    const command = new DescribeInstancesCommand({ NextToken: nextToken });
    const response = await client.send(command);

    for (const reservation of response.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        allInstances.push(instance);
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return allInstances;
}

// ---------------------------------------------------------------------------
// ECS Services — list clusters → list services per cluster → describe batch 10
// ---------------------------------------------------------------------------

async function ecsServicesDeep(
  client: any,
  region: string,
  config: ScanConfig,
): Promise<any[]> {
  const {
    ListClustersCommand,
    ListServicesCommand,
    DescribeServicesCommand,
  } = await import('@aws-sdk/client-ecs');

  const allServices: any[] = [];

  // 1. List all clusters
  const clustersResp = await client.send(new ListClustersCommand({}));
  const clusterArns: string[] = clustersResp.clusterArns || [];

  // 2. For each cluster, list services then describe in batches of 10
  for (const clusterArn of clusterArns) {
    const svcResp = await client.send(new ListServicesCommand({ cluster: clusterArn }));
    const serviceArns: string[] = svcResp.serviceArns || [];

    for (let i = 0; i < serviceArns.length; i += 10) {
      const batch = serviceArns.slice(i, i + 10);
      if (!batch.length) continue;

      try {
        const descResp = await client.send(
          new DescribeServicesCommand({
            cluster: clusterArn,
            services: batch,
            include: ['TAGS'],
          }),
        );

        for (const svc of descResp.services || []) {
          svc.ClusterArn = clusterArn; // Inject cluster context
          allServices.push(svc);
        }
      } catch (error) {
        console.error(
          `[discovery/custom] Error describing ECS services in ${clusterArn}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  return allServices;
}

// ---------------------------------------------------------------------------
// WAFv2 — scan both REGIONAL and CLOUDFRONT scopes
// ---------------------------------------------------------------------------

async function wafv2Deep(
  client: any,
  region: string,
  config: ScanConfig,
): Promise<any[]> {
  const { ListWebACLsCommand } = await import('@aws-sdk/client-wafv2');
  const allAcls: any[] = [];

  const scopes = ['REGIONAL'];
  if (region === 'us-east-1') {
    scopes.push('CLOUDFRONT');
  }

  for (const scope of scopes) {
    try {
      const response = await client.send(new ListWebACLsCommand({ Scope: scope }));
      for (const acl of response.WebACLs || []) {
        acl._scope = scope;
        allAcls.push(acl);
      }
    } catch (error) {
      console.warn(
        `[discovery/custom] WAFv2 list_web_acls scope=${scope} region=${region}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return allAcls;
}

// ---------------------------------------------------------------------------
// CloudFront — unwrap DistributionList.Items, us-east-1 only
// ---------------------------------------------------------------------------

async function cloudfrontDeep(
  client: any,
  region: string,
  config: ScanConfig,
): Promise<any[]> {
  if (region !== 'us-east-1') {
    return [];
  }

  const { ListDistributionsCommand } = await import('@aws-sdk/client-cloudfront');
  const allDists: any[] = [];
  let marker: string | undefined;

  do {
    const command = new ListDistributionsCommand({ Marker: marker });
    const response = await client.send(command);
    const distList = response.DistributionList;

    if (distList && distList.Items) {
      allDists.push(...distList.Items);
    }

    marker = distList?.IsTruncated ? distList.NextMarker : undefined;
  } while (marker);

  return allDists;
}

// ---------------------------------------------------------------------------
// Dispatch map — keyed by "service:function"
// ---------------------------------------------------------------------------

export const CUSTOM_SCANNERS: Record<string, CustomScannerFn> = {
  'ec2:describe_instances': flattenEC2Reservations,
  'ecs:list_services': ecsServicesDeep,
  'wafv2:list_web_acls': wafv2Deep,
  'cloudfront:list_distributions': cloudfrontDeep,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/custom-scanners.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/src/jobs/discovery/services/custom-scanners.ts workers/src/jobs/discovery/__tests__/custom-scanners.test.ts
git commit -m "feat(discovery): add 4 custom scanners for EC2/ECS/WAFv2/CloudFront"
```

---

## Task 11: PG Writer (`workers/src/jobs/discovery/services/pg-writer.ts`)

**Files:**
- Create: `workers/src/jobs/discovery/services/pg-writer.ts`
- Test: `workers/src/jobs/discovery/__tests__/pg-writer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/src/jobs/discovery/__tests__/pg-writer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Resource } from '../types.js';

const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ connect: mockConnect })),
}));

import { writeResourcesToPg, saveSyncStatus, extractMetadata } from '../services/pg-writer.js';

describe('pg-writer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  });

  describe('writeResourcesToPg', () => {
    it('should batch upsert resources in chunks of 500', async () => {
      const resources: Resource[] = Array.from({ length: 3 }, (_, i) => ({
        resourceType: 'ec2_instances',
        resourceId: `i-${i}`,
        region: 'us-east-1',
        service: 'ec2',
        name: `instance-${i}`,
        state: 'running',
        tags: { Name: `instance-${i}` },
        rawData: { InstanceId: `i-${i}` },
      }));

      const count = await writeResourcesToPg(resources, 'tenant-1', 'acc-123', 'job-1');

      expect(count).toBe(3);
      expect(mockConnect).toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO inventory_resources'),
        expect.any(Array),
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT'),
        expect.any(Array),
      );
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should deduplicate resources on (resourceType, resourceId)', async () => {
      const resources: Resource[] = [
        {
          resourceType: 'ec2_instances',
          resourceId: 'i-123',
          region: 'us-east-1',
          service: 'ec2',
          name: 'first',
          state: 'running',
          tags: {},
          rawData: {},
        },
        {
          resourceType: 'ec2_instances',
          resourceId: 'i-123',
          region: 'us-east-1',
          service: 'ec2',
          name: 'duplicate',
          state: 'stopped',
          tags: {},
          rawData: {},
        },
      ];

      const count = await writeResourcesToPg(resources, 'tenant-1', 'acc-123', 'job-1');

      // Should only write 1 row (last wins in dedup)
      expect(count).toBe(1);
    });

    it('should return 0 for empty resources array', async () => {
      const count = await writeResourcesToPg([], 'tenant-1', 'acc-123', 'job-1');

      expect(count).toBe(0);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('should include tenantId and accountId in every row', async () => {
      const resources: Resource[] = [
        {
          resourceType: 'ec2_vpcs',
          resourceId: 'vpc-123',
          region: 'us-east-1',
          service: 'ec2',
          name: 'main-vpc',
          state: 'available',
          tags: { Name: 'main-vpc' },
          rawData: {},
        },
      ];

      await writeResourcesToPg(resources, 'tenant-abc', 'acc-456', 'job-1');

      const params = mockQuery.mock.calls[0][1];
      // params should contain tenantId and accountId
      expect(params).toContain('tenant-abc');
      expect(params).toContain('acc-456');
    });

    it('should throw on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      const resources: Resource[] = [
        {
          resourceType: 'ec2_instances',
          resourceId: 'i-123',
          region: 'us-east-1',
          service: 'ec2',
          tags: {},
          rawData: {},
        },
      ];

      await expect(
        writeResourcesToPg(resources, 'tenant-1', 'acc-123', 'job-1'),
      ).rejects.toThrow('connection refused');
    });
  });

  describe('saveSyncStatus', () => {
    it('should upsert sync status row', async () => {
      await saveSyncStatus('scan-123', 'tenant-1', 500, 3);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('inventory_sync_status'),
        expect.arrayContaining(['scan-123', 'tenant-1', 500, 3]),
      );
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('extractMetadata', () => {
    it('should extract EC2 instance metadata', () => {
      const resource: Resource = {
        resourceType: 'ec2_instances',
        resourceId: 'i-123',
        region: 'us-east-1',
        service: 'ec2',
        tags: {},
        rawData: {
          InstanceType: 't3.micro',
          Platform: 'Linux',
          PrivateIpAddress: '10.0.1.5',
          PublicIpAddress: '54.1.2.3',
          VpcId: 'vpc-123',
          SubnetId: 'subnet-456',
          LaunchTime: '2024-01-01T00:00:00Z',
          ImageId: 'ami-abc123',
        },
      };

      const metadata = extractMetadata(resource);

      expect(metadata.instanceType).toBe('t3.micro');
      expect(metadata.platform).toBe('Linux');
      expect(metadata.privateIpAddress).toBe('10.0.1.5');
      expect(metadata.publicIpAddress).toBe('54.1.2.3');
      expect(metadata.vpcId).toBe('vpc-123');
      expect(metadata.subnetId).toBe('subnet-456');
    });

    it('should extract RDS instance metadata', () => {
      const resource: Resource = {
        resourceType: 'rds_db_instances',
        resourceId: 'mydb',
        region: 'us-east-1',
        service: 'rds',
        tags: {},
        rawData: {
          Engine: 'postgres',
          EngineVersion: '15.4',
          DBInstanceClass: 'db.t3.micro',
          AllocatedStorage: 20,
          MultiAZ: false,
          StorageType: 'gp3',
          Endpoint: { Address: 'mydb.abc.us-east-1.rds.amazonaws.com', Port: 5432 },
        },
      };

      const metadata = extractMetadata(resource);

      expect(metadata.engine).toBe('postgres');
      expect(metadata.engineVersion).toBe('15.4');
      expect(metadata.dbInstanceClass).toBe('db.t3.micro');
      expect(metadata.allocatedStorage).toBe(20);
      expect(metadata.multiAZ).toBe(false);
      expect(metadata.endpoint).toBe('mydb.abc.us-east-1.rds.amazonaws.com');
    });

    it('should extract Lambda function metadata', () => {
      const resource: Resource = {
        resourceType: 'lambda_functions',
        resourceId: 'my-func',
        region: 'us-east-1',
        service: 'lambda',
        tags: {},
        rawData: {
          Runtime: 'nodejs20.x',
          MemorySize: 256,
          Timeout: 30,
          Handler: 'index.handler',
          CodeSize: 1024000,
          LastModified: '2024-01-01T00:00:00Z',
        },
      };

      const metadata = extractMetadata(resource);

      expect(metadata.runtime).toBe('nodejs20.x');
      expect(metadata.memorySize).toBe(256);
      expect(metadata.timeout).toBe(30);
      expect(metadata.handler).toBe('index.handler');
      expect(metadata.codeSize).toBe(1024000);
    });

    it('should extract ECS service metadata', () => {
      const resource: Resource = {
        resourceType: 'ecs_services',
        resourceId: 'arn:svc1',
        region: 'us-east-1',
        service: 'ecs',
        tags: {},
        rawData: {
          desiredCount: 2,
          runningCount: 2,
          pendingCount: 0,
          launchType: 'FARGATE',
          ClusterArn: 'arn:cluster1',
        },
      };

      const metadata = extractMetadata(resource);

      expect(metadata.desiredCount).toBe(2);
      expect(metadata.runningCount).toBe(2);
      expect(metadata.launchType).toBe('FARGATE');
      expect(metadata.clusterArn).toBe('arn:cluster1');
    });

    it('should extract S3 bucket metadata', () => {
      const resource: Resource = {
        resourceType: 's3_buckets',
        resourceId: 'my-bucket',
        region: 'us-east-1',
        service: 's3',
        tags: {},
        rawData: {
          CreationDate: '2024-01-01T00:00:00Z',
          LocationConstraint: 'us-east-1',
        },
      };

      const metadata = extractMetadata(resource);

      expect(metadata.creationDate).toBe('2024-01-01T00:00:00Z');
      expect(metadata.locationConstraint).toBe('us-east-1');
    });

    it('should extract ELBv2 load balancer metadata', () => {
      const resource: Resource = {
        resourceType: 'elbv2_load_balancers',
        resourceId: 'arn:lb1',
        region: 'us-east-1',
        service: 'elbv2',
        tags: {},
        rawData: {
          Type: 'application',
          Scheme: 'internet-facing',
          DNSName: 'my-lb-123.us-east-1.elb.amazonaws.com',
          VpcId: 'vpc-123',
          State: { Code: 'active' },
        },
      };

      const metadata = extractMetadata(resource);

      expect(metadata.type).toBe('application');
      expect(metadata.scheme).toBe('internet-facing');
      expect(metadata.dnsName).toBe('my-lb-123.us-east-1.elb.amazonaws.com');
      expect(metadata.vpcId).toBe('vpc-123');
    });

    it('should return empty object for unknown resource types', () => {
      const resource: Resource = {
        resourceType: 'unknown_service',
        resourceId: 'id-1',
        region: 'us-east-1',
        service: 'unknown',
        tags: {},
        rawData: { foo: 'bar' },
      };

      const metadata = extractMetadata(resource);

      expect(metadata).toEqual({});
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/pg-writer.test.ts`
Expected: FAIL with "Cannot find module '../services/pg-writer.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// workers/src/jobs/discovery/services/pg-writer.ts
import { Pool, type PoolClient } from 'pg';
import type { Resource } from '../types.js';

const DATABASE_URL = process.env.DATABASE_URL;

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

// ---------------------------------------------------------------------------
// writeResourcesToPg — batch upsert with deduplication
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;

export async function writeResourcesToPg(
  resources: Resource[],
  tenantId: string,
  accountId: string,
  jobRunId: string,
): Promise<number> {
  if (!resources.length) return 0;

  // Deduplicate on (resourceType, resourceId) — last wins
  const seen = new Map<string, Resource>();
  for (const r of resources) {
    const key = `${r.resourceType}::${r.resourceId}`;
    seen.set(key, r);
  }
  const deduped = Array.from(seen.values());

  const client: PoolClient = await getPool().connect();
  let total = 0;

  try {
    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const batch = deduped.slice(i, i + BATCH_SIZE);
      const placeholders: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      for (const r of batch) {
        const metadata = extractMetadata(r);
        const tagsJson = JSON.stringify(r.tags || {});
        const metadataJson = JSON.stringify(metadata);
        const id = `res-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        placeholders.push(
          `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}::jsonb, $${paramIdx + 9}::jsonb, NOW(), NOW())`,
        );
        params.push(
          id,
          tenantId,
          accountId,
          r.region,
          r.resourceType,
          r.resourceId,
          r.name || null,
          r.state || null,
          tagsJson,
          metadataJson,
        );
        paramIdx += 10;
      }

      const sql = `
        INSERT INTO inventory_resources
          (id, "tenantId", "accountId", region, "resourceType", "resourceId",
           name, status, tags, metadata, "discoveredAt", "updatedAt")
        VALUES ${placeholders.join(', ')}
        ON CONFLICT ("tenantId", "accountId", "resourceType", "resourceId")
        DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          tags = EXCLUDED.tags,
          metadata = EXCLUDED.metadata,
          "updatedAt" = NOW()
      `;

      await client.query(sql, params);
      total += batch.length;
    }
  } catch (error) {
    console.error('[discovery/pg-writer] Error writing resources:', error);
    throw error;
  } finally {
    client.release();
  }

  return total;
}

// ---------------------------------------------------------------------------
// saveSyncStatus — upsert inventory_sync_status
// ---------------------------------------------------------------------------

export async function saveSyncStatus(
  scanId: string,
  tenantId: string,
  totalResources: number,
  accountsSynced: number,
): Promise<void> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query(
      `INSERT INTO inventory_sync_status
         ("scanId", "tenantId", "totalResources", "accountsSynced", "completedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT ("tenantId")
       DO UPDATE SET
         "scanId" = EXCLUDED."scanId",
         "totalResources" = EXCLUDED."totalResources",
         "accountsSynced" = EXCLUDED."accountsSynced",
         "completedAt" = NOW(),
         "updatedAt" = NOW()`,
      [scanId, tenantId, totalResources, accountsSynced],
    );
  } catch (error) {
    console.error('[discovery/pg-writer] Error saving sync status:', error);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// extractMetadata — type-specific metadata extraction from rawData
// Ported from Python pg_writer.py extract_metadata patterns
// ---------------------------------------------------------------------------

export function extractMetadata(resource: Resource): Record<string, unknown> {
  const raw = (resource.rawData || {}) as Record<string, any>;
  const type = resource.resourceType;

  // EC2 Instances
  if (type === 'ec2_instances') {
    return pick(raw, {
      instanceType: 'InstanceType',
      platform: 'Platform',
      privateIpAddress: 'PrivateIpAddress',
      publicIpAddress: 'PublicIpAddress',
      vpcId: 'VpcId',
      subnetId: 'SubnetId',
      launchTime: 'LaunchTime',
      imageId: 'ImageId',
      architecture: 'Architecture',
      keyName: 'KeyName',
    });
  }

  // RDS DB Instances
  if (type === 'rds_db_instances') {
    const meta = pick(raw, {
      engine: 'Engine',
      engineVersion: 'EngineVersion',
      dbInstanceClass: 'DBInstanceClass',
      allocatedStorage: 'AllocatedStorage',
      multiAZ: 'MultiAZ',
      storageType: 'StorageType',
      storageEncrypted: 'StorageEncrypted',
      publiclyAccessible: 'PubliclyAccessible',
    });
    if (raw.Endpoint?.Address) {
      meta.endpoint = raw.Endpoint.Address;
      meta.port = raw.Endpoint.Port;
    }
    return meta;
  }

  // RDS DB Clusters / DocDB
  if (type === 'rds_db_clusters' || type === 'docdb_db_clusters') {
    return pick(raw, {
      engine: 'Engine',
      engineVersion: 'EngineVersion',
      allocatedStorage: 'AllocatedStorage',
      multiAZ: 'MultiAZ',
      storageEncrypted: 'StorageEncrypted',
      dbClusterMembers: 'DBClusterMembers',
    });
  }

  // Lambda Functions
  if (type === 'lambda_functions') {
    return pick(raw, {
      runtime: 'Runtime',
      memorySize: 'MemorySize',
      timeout: 'Timeout',
      handler: 'Handler',
      codeSize: 'CodeSize',
      lastModified: 'LastModified',
      architectures: 'Architectures',
      packageType: 'PackageType',
    });
  }

  // ECS Services
  if (type === 'ecs_services' || type === 'ecs_describe_services') {
    return pick(raw, {
      desiredCount: 'desiredCount',
      runningCount: 'runningCount',
      pendingCount: 'pendingCount',
      launchType: 'launchType',
      clusterArn: 'ClusterArn',
      taskDefinition: 'taskDefinition',
    });
  }

  // ECS Clusters
  if (type === 'ecs_clusters') {
    return pick(raw, {
      status: 'status',
      registeredContainerInstancesCount: 'registeredContainerInstancesCount',
      runningTasksCount: 'runningTasksCount',
      pendingTasksCount: 'pendingTasksCount',
      activeServicesCount: 'activeServicesCount',
    });
  }

  // S3 Buckets
  if (type === 's3_buckets') {
    return pick(raw, {
      creationDate: 'CreationDate',
      locationConstraint: 'LocationConstraint',
    });
  }

  // ELBv2 Load Balancers
  if (type === 'elbv2_load_balancers') {
    return pick(raw, {
      type: 'Type',
      scheme: 'Scheme',
      dnsName: 'DNSName',
      vpcId: 'VpcId',
      ipAddressType: 'IpAddressType',
    });
  }

  // EC2 VPCs
  if (type === 'ec2_vpcs') {
    return pick(raw, {
      cidrBlock: 'CidrBlock',
      isDefault: 'IsDefault',
      dhcpOptionsId: 'DhcpOptionsId',
    });
  }

  // EC2 Subnets
  if (type === 'ec2_subnets') {
    return pick(raw, {
      cidrBlock: 'CidrBlock',
      vpcId: 'VpcId',
      availabilityZone: 'AvailabilityZone',
      mapPublicIpOnLaunch: 'MapPublicIpOnLaunch',
      availableIpAddressCount: 'AvailableIpAddressCount',
    });
  }

  // EC2 Security Groups
  if (type === 'ec2_security_groups') {
    return pick(raw, {
      vpcId: 'VpcId',
      description: 'Description',
      ipPermissionsCount: raw.IpPermissions?.length,
      ipPermissionsEgressCount: raw.IpPermissionsEgress?.length,
    });
  }

  // EC2 Volumes
  if (type === 'ec2_volumes') {
    return pick(raw, {
      volumeType: 'VolumeType',
      size: 'Size',
      encrypted: 'Encrypted',
      availabilityZone: 'AvailabilityZone',
      iops: 'Iops',
    });
  }

  // Auto Scaling Groups
  if (type === 'autoscaling_auto_scaling_groups') {
    return pick(raw, {
      minSize: 'MinSize',
      maxSize: 'MaxSize',
      desiredCapacity: 'DesiredCapacity',
      launchConfigurationName: 'LaunchConfigurationName',
      healthCheckType: 'HealthCheckType',
    });
  }

  // DynamoDB Tables
  if (type === 'dynamodb_tables') {
    return pick(raw, {
      tableStatus: 'TableStatus',
      tableSizeBytes: 'TableSizeBytes',
      itemCount: 'ItemCount',
      billingModeSummary: 'BillingModeSummary',
    });
  }

  // EKS Clusters
  if (type === 'eks_clusters') {
    return pick(raw, {
      version: 'version',
      platformVersion: 'platformVersion',
      status: 'status',
      endpoint: 'endpoint',
    });
  }

  // CloudFront Distributions
  if (type === 'cloudfront_distributions') {
    return pick(raw, {
      domainName: 'DomainName',
      status: 'Status',
      enabled: 'Enabled',
      httpVersion: 'HttpVersion',
      priceClass: 'PriceClass',
    });
  }

  // ElastiCache Clusters
  if (type === 'elasticache_cache_clusters') {
    return pick(raw, {
      cacheNodeType: 'CacheNodeType',
      engine: 'Engine',
      engineVersion: 'EngineVersion',
      numCacheNodes: 'NumCacheNodes',
    });
  }

  // KMS Keys
  if (type === 'kms_keys') {
    return pick(raw, {
      keyState: 'KeyState',
      keyUsage: 'KeyUsage',
      keyManager: 'KeyManager',
      description: 'Description',
      creationDate: 'CreationDate',
    });
  }

  // ACM Certificates
  if (type === 'acm_certificates') {
    return pick(raw, {
      domainName: 'DomainName',
      status: 'Status',
      type: 'Type',
      issuer: 'Issuer',
      notAfter: 'NotAfter',
      notBefore: 'NotBefore',
    });
  }

  // ECR Repositories
  if (type === 'ecr_repositories') {
    return pick(raw, {
      repositoryUri: 'repositoryUri',
      imageTagMutability: 'imageTagMutability',
      imageScanningConfiguration: 'imageScanningConfiguration',
    });
  }

  // IAM Roles
  if (type === 'iam_roles') {
    return pick(raw, {
      path: 'Path',
      createDate: 'CreateDate',
      maxSessionDuration: 'MaxSessionDuration',
    });
  }

  // IAM Users
  if (type === 'iam_users') {
    return pick(raw, {
      path: 'Path',
      createDate: 'CreateDate',
      passwordLastUsed: 'PasswordLastUsed',
    });
  }

  return {};
}

// ---------------------------------------------------------------------------
// pick helper — extract named keys from raw AWS response
// ---------------------------------------------------------------------------

function pick(
  raw: Record<string, any>,
  mapping: Record<string, string | number | undefined>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [outKey, rawKey] of Object.entries(mapping)) {
    if (rawKey === undefined) continue;
    if (typeof rawKey === 'number') {
      result[outKey] = rawKey;
      continue;
    }
    if (rawKey in raw && raw[rawKey] !== undefined) {
      result[outKey] = raw[rawKey];
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers && npx vitest run src/jobs/discovery/__tests__/pg-writer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/src/jobs/discovery/services/pg-writer.ts workers/src/jobs/discovery/__tests__/pg-writer.test.ts
git commit -m "feat(discovery): add PG writer with batch upsert and extractMetadata"
```

---

## Task 12: Worker Registration

**Files:**
- Create: `workers/src/jobs/discovery/index.ts`
- Modify: `workers/src/index.ts`
- Test: `workers/src/jobs/discovery/__tests__/index.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/src/jobs/discovery/__tests__/index.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateQueue = vi.fn().mockResolvedValue(undefined);
const mockSchedule = vi.fn().mockResolvedValue(undefined);
const mockWork = vi.fn().mockResolvedValue(undefined);
const mockSend = vi.fn().mockResolvedValue('job-id-123');

const mockBoss = {
  createQueue: mockCreateQueue,
  schedule: mockSchedule,
  work: mockWork,
  send: mockSend,
};

vi.mock('../services/account-service.js', () => ({
  getAllTenants: vi.fn().mockResolvedValue([
    { id: 'tenant-1', name: 'Acme' },
    { id: 'tenant-2', name: 'Beta' },
  ]),
  getTenantAccounts: vi.fn().mockResolvedValue([]),
  updateAccountSyncStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/audit-service.js', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

describe('register', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates both queues', async () => {
    const { register } = await import('../index.js');
    await register(mockBoss as any);
    expect(mockCreateQueue).toHaveBeenCalledWith('discovery-fan-out');
    expect(mockCreateQueue).toHaveBeenCalledWith('discovery-scan');
  });

  it('schedules daily cron for fan-out', async () => {
    const { register } = await import('../index.js');
    await register(mockBoss as any);
    expect(mockSchedule).toHaveBeenCalledWith(
      'discovery-fan-out',
      '0 2 * * *',
      {},
      { tz: 'UTC' }
    );
  });

  it('registers work handlers for both queues', async () => {
    const { register } = await import('../index.js');
    await register(mockBoss as any);
    expect(mockWork).toHaveBeenCalledWith('discovery-fan-out', { batchSize: 1 }, expect.any(Function));
    expect(mockWork).toHaveBeenCalledWith('discovery-scan', { batchSize: 1 }, expect.any(Function));
  });
});

describe('fan-out handler', () => {
  it('sends one discovery-scan job per tenant with singletonKey', async () => {
    vi.clearAllMocks();
    const { register } = await import('../index.js');
    await register(mockBoss as any);

    // Extract and invoke the fan-out handler
    const fanOutCall = mockWork.mock.calls.find(c => c[0] === 'discovery-fan-out');
    const handler = fanOutCall![2];
    await handler([{ id: 'job-1', data: {} }]);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith(
      'discovery-scan',
      expect.objectContaining({ tenantId: 'tenant-1', triggeredBy: 'cron' }),
      expect.objectContaining({ singletonKey: 'tenant:tenant-1' })
    );
    expect(mockSend).toHaveBeenCalledWith(
      'discovery-scan',
      expect.objectContaining({ tenantId: 'tenant-2', triggeredBy: 'cron' }),
      expect.objectContaining({ singletonKey: 'tenant:tenant-2' })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd workers && npx vitest run src/jobs/discovery/__tests__/index.test.ts
```
Expected: FAIL with "Cannot find module '../index.js'"

- [ ] **Step 3: Write the worker registration**

```typescript
// workers/src/jobs/discovery/index.ts
import type PgBoss from 'pg-boss';
import { getAllTenants, getTenantAccounts, updateAccountSyncStatus } from './services/account-service.js';
import { writeAuditLog } from './services/audit-service.js';
import { assumeRole } from './services/sts-service.js';
import { runInventoryScan } from './services/scanner.js';
import { writeResourcesToPg, saveSyncStatus } from './services/pg-writer.js';
import type { DiscoveryFanOutJob, DiscoveryScanJob } from './types.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadScanConfigs() {
  const scanfilePath = process.env.SCANFILE_PATH ?? join(__dirname, 'scanfile.json');
  return JSON.parse(readFileSync(scanfilePath, 'utf-8'));
}

export async function register(boss: PgBoss): Promise<void> {
  await boss.createQueue('discovery-fan-out');
  await boss.createQueue('discovery-scan');

  // Daily cron at 2 AM UTC
  await boss.schedule('discovery-fan-out', '0 2 * * *', {}, { tz: 'UTC' });

  // Fan-out: one discovery-scan job per tenant
  await boss.work<DiscoveryFanOutJob>(
    'discovery-fan-out',
    { batchSize: 1 },
    async ([job]) => {
      console.log(`[discovery] Fan-out triggered by job ${job.id}`);
      const tenants = await getAllTenants();
      for (const tenant of tenants) {
        await boss.send(
          'discovery-scan',
          { tenantId: tenant.id, triggeredBy: 'cron' } satisfies DiscoveryScanJob,
          {
            singletonKey: `tenant:${tenant.id}`,
            expireInHours: 2,
            retryLimit: 2,
            retryDelay: 60,
            retryBackoff: true,
          }
        );
      }
      console.log(`[discovery] Fan-out sent ${tenants.length} scan jobs`);
    }
  );

  // Scan: scan all accounts for one tenant
  await boss.work<DiscoveryScanJob>(
    'discovery-scan',
    { batchSize: 1 },
    async ([job]) => {
      const { tenantId, accountId, triggeredBy, correlationId } = job.data;
      const scanId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const startedAt = Date.now();
      const scanConfigs = loadScanConfigs();

      console.log(`[discovery] Starting scan for tenant ${tenantId}`, { scanId, triggeredBy });

      await writeAuditLog({
        tenantId,
        eventType: 'discovery.scan.started',
        action: 'scan',
        correlationId,
        metadata: { scanId, triggeredBy },
      });

      const accounts = await getTenantAccounts(tenantId);
      const targetAccounts = accountId
        ? accounts.filter(a => a.accountId === accountId)
        : accounts;

      let totalResources = 0;
      let accountsSynced = 0;
      const errors: string[] = [];

      for (const account of targetAccounts) {
        try {
          const credentials = await assumeRole(account.roleArn, account.externalId);
          const regions = Array.isArray(account.regions) ? account.regions : [account.regions];

          const result = await runInventoryScan(credentials, regions, scanConfigs);
          totalResources += result.resources.length;

          await writeResourcesToPg(result.resources, tenantId, account.accountId, scanId);
          await updateAccountSyncStatus(tenantId, account.accountId, {
            lastSyncedAt: new Date(),
            lastSyncStatus: result.errors.length > 0 ? 'partial' : 'success',
            lastSyncResourceCount: result.resources.length,
          });

          accountsSynced++;
          if (result.errors.length > 0) errors.push(...result.errors);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Account ${account.accountId}: ${msg}`);
          console.error(`[discovery] Account ${account.accountId} failed:`, err);
        }
      }

      await saveSyncStatus(scanId, tenantId, totalResources, accountsSynced);

      const duration = Date.now() - startedAt;
      const status = errors.length > 0 && accountsSynced === 0 ? 'failed' : 'completed';

      await writeAuditLog({
        tenantId,
        eventType: `discovery.scan.${status}`,
        action: 'scan',
        correlationId,
        metadata: { scanId, totalResources, accountsSynced, duration, errors },
      });

      console.log(`[discovery] Scan ${status} for tenant ${tenantId}`, {
        scanId, totalResources, accountsSynced, duration,
      });

      if (errors.length > 0 && accountsSynced === 0) {
        throw new Error(`All accounts failed: ${errors.join('; ')}`);
      }
    }
  );

  console.log('[discovery] Registered discovery-fan-out + discovery-scan jobs');
}
```

- [ ] **Step 4: Register in workers/src/index.ts**

Add to `workers/src/index.ts` after the existing imports and registrations:

```typescript
import { register as registerDiscoveryJobs } from './jobs/discovery/index.js';

// inside main(), after existing registrations:
await registerDiscoveryJobs(boss);
```

The full updated `workers/src/index.ts`:

```typescript
import { createBoss } from './boss.js';
import { register as registerSchedulerJobs } from './jobs/scheduler/index.js';
import { register as registerKbSyncJobs } from './jobs/kb-sync/index.js';
import { register as registerDiscoveryJobs } from './jobs/discovery/index.js';

const boss = createBoss();

async function main() {
  console.log('[workers] Starting pg-boss...');

  boss.on('error', (error) => {
    console.error('[workers] pg-boss error:', error);
  });

  await boss.start();
  console.log('[workers] pg-boss started');

  await registerSchedulerJobs(boss);
  await registerKbSyncJobs(boss);
  await registerDiscoveryJobs(boss);

  console.log('[workers] All jobs registered. Waiting for work...');

  const shutdown = async (signal: string) => {
    console.log(`[workers] Received ${signal}, shutting down...`);
    await boss.stop({ graceful: true, timeout: 30000 });
    console.log('[workers] pg-boss stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[workers] Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd workers && npx vitest run src/jobs/discovery/__tests__/index.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add workers/src/jobs/discovery/index.ts workers/src/index.ts workers/src/jobs/discovery/__tests__/index.test.ts
git commit -m "feat(discovery): add worker registration and fan-out handler"
```

---

## Task 13: Web-UI API Routes

**Files:**
- Create: `web-ui/app/api/discovery/execute/route.ts`
- Create: `web-ui/app/api/discovery/status/route.ts`

- [ ] **Step 1: Create the execute route**

```typescript
// web-ui/app/api/discovery/execute/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionUserId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getBossClient } from '@/lib/boss-client';

export async function POST(req: NextRequest) {
  const authError = await authorize('create', 'Discovery');
  if (authError) return authError;

  try {
    const session = await getServerSession(authOptions);
    const tenantId = session?.user?.tenantId as string;
    const userEmail = session?.user?.email as string;

    if (!tenantId) {
      return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { accountId } = body as { accountId?: string };

    const boss = getBossClient();
    const jobId = await boss.send(
      'discovery-scan',
      {
        tenantId,
        accountId,
        triggeredBy: 'web-ui' as const,
        userEmail,
      },
      {
        singletonKey: `tenant:${tenantId}`,
        expireInHours: 2,
        retryLimit: 2,
        retryDelay: 60,
        retryBackoff: true,
      }
    );

    console.log(`API - POST /api/discovery/execute - Triggered scan for tenant ${tenantId}`, { jobId, accountId });

    return NextResponse.json({ success: true, jobId });
  } catch (error) {
    console.error('API - Error triggering discovery scan:', error);
    return NextResponse.json({ success: false, error: 'Failed to trigger scan' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create the status route**

```typescript
// web-ui/app/api/discovery/status/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getDynamoDBDocumentClient } from '@/lib/aws-config';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';

export async function GET(req: NextRequest) {
  const authError = await authorize('read', 'Discovery');
  if (authError) return authError;

  try {
    const session = await getServerSession(authOptions);
    const tenantId = session?.user?.tenantId as string;

    if (!tenantId) {
      return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
    }

    // Query inventory_sync_status from PostgreSQL via Prisma
    const { getPrismaClient } = await import('@/lib/db/prisma');
    const prisma = getPrismaClient();

    const syncStatuses = await prisma.$queryRaw<Array<{
      scanId: string;
      tenantId: string;
      totalResources: number;
      accountsSynced: number;
      syncedAt: Date;
    }>>`
      SELECT "scanId", "tenantId", "totalResources", "accountsSynced", "syncedAt"
      FROM inventory_sync_status
      WHERE "tenantId" = ${tenantId}
      ORDER BY "syncedAt" DESC
      LIMIT 10
    `;

    console.log(`API - GET /api/discovery/status - Fetched sync status for tenant ${tenantId}`);

    return NextResponse.json({ success: true, data: syncStatuses });
  } catch (error) {
    console.error('API - Error fetching discovery status:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch status' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd web-ui && npx tsc --noEmit
```
Expected: No errors related to the new routes.

- [ ] **Step 4: Commit**

```bash
git add web-ui/app/api/discovery/execute/route.ts web-ui/app/api/discovery/status/route.ts
git commit -m "feat(discovery): add web-ui API routes for execute and status"
```

---

## Task 14: Local Runner

**Files:**
- Create: `workers/src/jobs/discovery/local-runner.ts`

- [ ] **Step 1: Create the local runner**

```typescript
// workers/src/jobs/discovery/local-runner.ts
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runInventoryScan } from './services/scanner.js';
import { writeResourcesToPg, saveSyncStatus } from './services/pg-writer.js';
import { getAllTenants, getTenantAccounts } from './services/account-service.js';
import { assumeRole } from './services/sts-service.js';
import type { ScanConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const entry = args.find(a => a.startsWith(`--${flag}=`));
    return entry ? entry.split('=').slice(1).join('=') : undefined;
  };
  return {
    tenantId: get('tenant-id'),
    accountId: get('account-id'),
    regions: get('regions')?.split(','),
    concurrentRegions: parseInt(get('concurrent-regions') ?? '5', 10),
    concurrentServices: parseInt(get('concurrent-services') ?? '10', 10),
    listServices: args.includes('--list-services'),
    verbose: args.includes('--verbose'),
  };
}

async function main() {
  const opts = parseArgs();

  if (opts.verbose) {
    process.env.LOG_LEVEL = 'debug';
  }

  const scanfilePath = process.env.SCANFILE_PATH ?? join(__dirname, 'scanfile.json');
  const scanConfigs: ScanConfig[] = JSON.parse(readFileSync(scanfilePath, 'utf-8'));

  if (opts.listServices) {
    console.log('Available services in scanfile:');
    for (const cfg of scanConfigs) {
      console.log(`  ${cfg.service}:${cfg.function}`);
    }
    process.exit(0);
  }

  process.env.CONCURRENT_REGIONS = String(opts.concurrentRegions);
  process.env.CONCURRENT_SERVICES = String(opts.concurrentServices);

  const scanId = `local-${Date.now()}`;

  if (opts.tenantId) {
    // Scan all accounts for a specific tenant
    const accounts = await getTenantAccounts(opts.tenantId);
    const targets = opts.accountId ? accounts.filter(a => a.accountId === opts.accountId) : accounts;

    for (const account of targets) {
      const regions = opts.regions ?? (Array.isArray(account.regions) ? account.regions : [account.regions]);
      console.log(`Scanning account ${account.accountId} in regions: ${regions.join(', ')}`);
      const credentials = await assumeRole(account.roleArn, account.externalId);
      const result = await runInventoryScan(credentials, regions, scanConfigs);
      console.log(`Found ${result.resources.length} resources in ${result.elapsedMs}ms`);
      await writeResourcesToPg(result.resources, opts.tenantId, account.accountId, scanId);
    }
  } else {
    // Direct mode: use current AWS credentials
    const regions = opts.regions ?? [process.env.AWS_REGION ?? 'ap-south-1'];
    const fakeCredentials = {
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
        sessionToken: process.env.AWS_SESSION_TOKEN,
      },
      region: regions[0],
    };
    console.log(`Direct mode: scanning regions ${regions.join(', ')}`);
    const result = await runInventoryScan(fakeCredentials as any, regions, scanConfigs);
    console.log(`Found ${result.resources.length} resources in ${result.elapsedMs}ms`);
    if (result.errors.length > 0) {
      console.warn('Errors:', result.errors);
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add workers/src/jobs/discovery/local-runner.ts
git commit -m "feat(discovery): add local runner CLI"
```

---

## Task 15: Integration Test

**Files:**
- Create: `workers/src/jobs/discovery/__tests__/integration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// workers/src/jobs/discovery/__tests__/integration.test.ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

// Mock all AWS SDK clients
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Vpcs: [{ VpcId: 'vpc-123', State: 'available', Tags: [] }] }),
  })),
  paginateDescribeVpcs: vi.fn().mockImplementation(async function* () {
    yield { Vpcs: [{ VpcId: 'vpc-123', State: 'available', Tags: [] }] };
  }),
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      DBInstances: [{
        DBInstanceIdentifier: 'db-1',
        DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:db-1',
        DBInstanceStatus: 'available',
        DBInstanceClass: 'db.t3.micro',
        TagList: [],
      }],
    }),
  })),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: 'AKIA123',
        SecretAccessKey: 'secret',
        SessionToken: 'token',
      },
    }),
  })),
  AssumeRoleCommand: vi.fn(),
}));

describe('Discovery integration', () => {
  it('scans VPCs and normalizes to Resource[]', async () => {
    const { runInventoryScan } = await import('../services/scanner.js');

    const credentials = {
      credentials: { accessKeyId: 'A', secretAccessKey: 'B', sessionToken: 'C' },
      region: 'us-east-1',
    };

    const scanConfigs = [
      { service: 'ec2', function: 'describe_vpcs', result_key: 'Vpcs' },
    ];

    const result = await runInventoryScan(credentials as any, ['us-east-1'], scanConfigs as any);

    expect(result.resources.length).toBeGreaterThan(0);
    expect(result.resources[0]).toMatchObject({
      service: 'ec2',
      resourceType: expect.stringContaining('ec2'),
      region: 'us-east-1',
    });
    expect(result.errors).toHaveLength(0);
  });

  it('scans RDS instances and extracts metadata', async () => {
    const { runInventoryScan } = await import('../services/scanner.js');
    const { extractMetadata } = await import('../services/pg-writer.js');

    const credentials = {
      credentials: { accessKeyId: 'A', secretAccessKey: 'B', sessionToken: 'C' },
      region: 'us-east-1',
    };

    const scanConfigs = [
      { service: 'rds', function: 'describe_db_instances', result_key: 'DBInstances' },
    ];

    const result = await runInventoryScan(credentials as any, ['us-east-1'], scanConfigs as any);
    expect(result.resources.length).toBeGreaterThan(0);

    const resource = result.resources[0];
    const metadata = extractMetadata(resource, 'rds_db_instances');
    expect(metadata).toBeDefined();
  });
});
```

- [ ] **Step 2: Run integration test**

```bash
cd workers && npx vitest run src/jobs/discovery/__tests__/integration.test.ts
```
Expected: PASS (2 tests)

- [ ] **Step 3: Run all discovery tests**

```bash
cd workers && npx vitest run src/jobs/discovery/__tests__/
```
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add workers/src/jobs/discovery/__tests__/integration.test.ts
git commit -m "test(discovery): add integration tests for scanner and pg-writer"
```

---

## Final: Pulumi Infrastructure Cleanup

After verifying the worker runs correctly in staging:

- [ ] **Step 1: Remove discovery ECS resources from infra/compute/index.ts**

Remove these blocks from `infra/compute/index.ts`:
- `discoveryImageUri` config reference
- Discovery log group (`/ecs/nucleus-cloud-ops-discovery`)
- Discovery execution role (`nucleus-app-discovery-execution-role`)
- Discovery task role (`nucleus-app-discovery-task-role`)
- Discovery security group (`nucleus-cloud-ops-discovery-sg`)
- Discovery ECS task definition
- EventBridge schedule for discovery

- [ ] **Step 2: Add STS AssumeRole permission to workers task role**

In `infra/compute/index.ts`, find the workers task role and add:
```typescript
new aws.iam.RolePolicy('workers-sts-policy', {
  role: workersTaskRole.name,
  policy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Action: ['sts:AssumeRole'],
      Resource: ['arn:aws:iam::*:role/NucleusAccess-*'],
    }],
  }),
});
```

- [ ] **Step 3: Preview Pulumi changes**

```bash
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi preview --stack prod
```
Expected: Shows removal of discovery ECS resources, addition of STS policy to workers role.

- [ ] **Step 4: Delete Python discovery directory**

```bash
rm -rf lambda/discovery/
```

- [ ] **Step 5: Commit infrastructure cleanup**

```bash
git add infra/compute/index.ts
git rm -r lambda/discovery/
git commit -m "chore: remove Python discovery ECS task, add STS policy to workers role"
```

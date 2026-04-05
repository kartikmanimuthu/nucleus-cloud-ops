---
title: Discovery Job — pg-boss Worker Integration
date: 2026-04-05
status: approved
supersedes: 2026-04-04-discovery-ts-rewrite-design.md
---

# Discovery Job — pg-boss Worker Integration

## Overview

Rewrite the Python discovery ECS Fargate task (`lambda/discovery/`) as a TypeScript pg-boss worker in `workers/src/jobs/discovery/`. The worker follows the same patterns as the existing scheduler and kb-sync workers, uses the aws-auto-inventory architecture (single generic engine + config-driven scanfile), and persists exclusively to PostgreSQL.

**What changes:**
- Runtime: Python ECS Fargate task → TypeScript pg-boss worker (same container as scheduler/kb-sync)
- Language: Python → TypeScript
- Persistence: DynamoDB + S3 + Iceberg → PostgreSQL only
- Trigger: EventBridge → pg-boss cron (daily) + on-demand from web-ui
- Concurrency: ThreadPoolExecutor → Promise.all with p-limit
- Deep scanners: 15 per-service handlers → declarative enrichments in scanfile.json (3-4 custom handlers for truly unique cases)
- Audit: DynamoDB NucleusAuditTable → PostgreSQL audit_logs table

**What stays identical:**
- All 40 service scanning configs (scanfile.json format)
- Cross-account STS AssumeRole pattern
- Resource normalization and metadata extraction logic
- Partial failure handling (successful accounts still written)
- Local runner CLI flags and behavior

---

## Queue Architecture & Job Flow

### Two queues

| Queue | Trigger | Payload | Batch Size | Retry |
|-------|---------|---------|------------|-------|
| `discovery-fan-out` | Daily cron (`0 2 * * *` UTC) | `{}` | 1 | retryLimit 1, expireInMinutes 5 |
| `discovery-scan` | Fan-out handler OR web-ui on-demand | `{ tenantId, accountId?, triggeredBy, userEmail?, correlationId? }` | 1 | retryLimit 2, retryDelay 60s, retryBackoff true, expireInHours 2 |

### Flow — scheduled (daily)

```
cron (2 AM UTC)
  → discovery-fan-out job
    → handler queries all active tenants from PostgreSQL
    → boss.send('discovery-scan', { tenantId, triggeredBy: 'cron' }) × N tenants
      → each discovery-scan job (singletonKey: tenant:{tenantId}):
          → fetch tenant's accounts from PostgreSQL
          → write audit log: discovery.scan.started
          → for each account:
              → assumeRole → scan regions × services → normalize → pg upsert
              → update account sync status
          → save sync status
          → write audit log: discovery.scan.completed (or .failed)
```

### Flow — on-demand (web-ui)

```
POST /api/discovery/execute { accountId? }
  → boss.send('discovery-scan', { tenantId, accountId?, triggeredBy: 'web-ui', userEmail })
    → same discovery-scan handler
    → if accountId provided: scan only that account
    → if not: scan all tenant accounts
```

### Singleton protection

`singletonKey: tenant:${tenantId}` on `discovery-scan` jobs prevents duplicate scans for the same tenant if a previous scan is still running.

---

## File Structure

```
workers/src/jobs/discovery/
├── index.ts                  # register(): createQueue, schedule cron, work handlers
├── types.ts                  # DiscoveryScanJob, DiscoveryFanOutJob, Account, Resource,
│                             #   ScanConfig, EnrichmentStep, ScanResult, SyncStatus
├── services/
│   ├── scanner.ts            # SERVICE_REGISTRY, invokeService, applyEnrichments,
│   │                         #   runInventoryScan, normalizeResources, extractResourceIdentifiers,
│   │                         #   generic enrichment engine (tags/describe/detail handlers)
│   ├── custom-scanners.ts    # 4 unique cases: EC2 (flatten Reservations), ECS services
│   │                         #   (nested under clusters), WAFv2 (dual-scope), CloudFront (us-east-1)
│   ├── pg-writer.ts          # writeResourcesToPg (batch 500), saveSyncStatus, extractMetadata
│   ├── account-service.ts    # getAllTenants, getTenantAccounts, updateAccountSyncStatus
│   ├── sts-service.ts        # assumeRole with optional ExternalId
│   └── audit-service.ts      # writeAuditLog → PostgreSQL audit_logs table
├── scanfile.json             # 40 service configs with declarative enrichment steps
├── local-runner.ts           # tsx local dev runner — CLI flags (see Local Development below)
└── utils/
    └── logger.ts             # Structured JSON logger
```

---

## Scanfile Schema with Declarative Enrichments

The scanfile extends the aws-auto-inventory format with an `enrichments` array. The engine reads these and applies them generically — no per-service code needed.

### Enrichment types

| Type | What it does | Config keys |
|------|-------------|-------------|
| `tags` | Calls a tag-fetching API per resource (or batched), merges into `resource.Tags` | `method`, `arnKey` or `nameKey`, `inputKey`, `batchSize?` |
| `describe` | Calls a describe API to get full resource data (for list→describe patterns) | `method`, `inputKey`, `resultKey`, `batchSize?`, `idKey` |
| `detail` | Calls a per-resource detail API, merges result into resource metadata | `method`, `nameKey` or `arnKey`, `inputKey`, `mergeKey?` |

### Examples

```jsonc
// Simple — no enrichment needed (describe already returns full data)
{ "service": "ec2", "function": "describe_vpcs", "result_key": "Vpcs" }

// Tags via ARN
{
  "service": "rds", "function": "describe_db_instances", "result_key": "DBInstances",
  "enrichments": [
    { "type": "tags", "method": "list_tags_for_resource", "arnKey": "DBInstanceArn" }
  ]
}

// List → Describe → Tags (ECS clusters)
{
  "service": "ecs", "function": "list_clusters", "result_key": "clusterArns",
  "enrichments": [
    { "type": "describe", "method": "describe_clusters", "inputKey": "clusters",
      "resultKey": "clusters", "batchSize": 100 },
    { "type": "tags", "method": "list_tags_for_resource", "arnKey": "clusterArn" }
  ]
}

// Tags via name (not ARN) + detail enrichment
{
  "service": "s3", "function": "list_buckets", "result_key": "Buckets",
  "enrichments": [
    { "type": "tags", "method": "get_bucket_tagging", "nameKey": "Name", "inputKey": "Bucket" },
    { "type": "detail", "method": "get_bucket_location", "nameKey": "Name", "inputKey": "Bucket" }
  ],
  "constraints": { "regionFilter": true }
}

// Batch tags (ELBv2 — describe_tags takes up to 20 ARNs)
{
  "service": "elbv2", "function": "describe_load_balancers", "result_key": "LoadBalancers",
  "enrichments": [
    { "type": "tags", "method": "describe_tags", "arnKey": "LoadBalancerArn",
      "inputKey": "ResourceArns", "batchSize": 20 }
  ]
}
```

### Constraints field

```jsonc
{ "regionFilter": true }                          // S3: filter buckets by current scan region
{ "regionOverride": "us-east-1" }                  // CloudFront: always scan us-east-1
{ "scopes": ["REGIONAL", "CLOUDFRONT"] }           // WAFv2: scan both scopes
```

### Custom handlers (escape hatch)

Only 4 cases that can't be expressed declaratively:

| Service:Function | Why custom |
|-----------------|-----------|
| `ec2:describe_instances` | Must flatten `Reservations[].Instances[]` before normalization |
| `ecs:list_services` | Nested: list clusters → list services per cluster → describe services |
| `wafv2:list_web_acls` | Must scan both `REGIONAL` and `CLOUDFRONT` scopes, us-east-1 only for CLOUDFRONT |
| `cloudfront:list_distributions` | Must unwrap `DistributionList.Items`, us-east-1 only |

---

## Scanner Engine (`scanner.ts`)

### SERVICE_REGISTRY

Maps scanfile `service` string → AWS SDK v3 client constructor. Only place that imports AWS SDK packages. Adding a new service = one line here.

```typescript
const SERVICE_REGISTRY: Record<string, new (config: any) => any> = {
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
  docdb: RDSClient,  // DocDB uses RDS client
};
```

### `invokeService(client, scanConfig)`

Generic API caller:
1. Convert scanfile `function` name to SDK v3 command: `describe_instances` → `DescribeInstancesCommand`
2. Try paginator first (SDK v3 `paginateXxx`)
3. Fallback to single `client.send(command)` if not pageable
4. Extract `result_key` from response
5. Exponential backoff on `ThrottlingException` / `RequestLimitExceeded` (max 3 retries, base 2s)

### `applyEnrichments(client, resources, enrichments)`

Generic enrichment engine:
1. Iterate enrichment steps in order
2. `type: "tags"` — call tag API per resource (or batched if `batchSize`), merge into `resource.Tags`
3. `type: "describe"` — batch resource IDs, call describe API, replace list items with full objects
4. `type: "detail"` — call detail API per resource, merge into resource object
5. All enrichment calls use the same retry/backoff logic

### `runInventoryScan(credentials, regions, scanConfigs)`

Orchestrator with p-limit concurrency:
```typescript
const regionLimit = pLimit(CONCURRENT_REGIONS);   // default 5
const serviceLimit = pLimit(CONCURRENT_SERVICES); // default 10

// Fan out: regions × services
for each (region, scanConfig):
    → check CUSTOM_SCANNERS first (4 special cases)
    → else: invokeService() → applyEnrichments() → normalizeResources()
```

### `normalizeResources(rawItems, service, function)`

Converts raw AWS responses to `Resource[]`:
- String items (ARNs, names): extract ID from last `/` or `:` segment
- Object items: call `extractResourceIdentifiers()` for id/arn/name/state/tags
- Resource type: `${service}_${function}` with `describe_/list_/get_` stripped

### Function name → Command mapping

```typescript
// "describe_instances" → "DescribeInstancesCommand"
function toCommandName(fn: string): string {
  return fn.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join('') + 'Command';
}
```

Scanfile stays compatible with the Python version's naming convention.

---

## Data Persistence — PostgreSQL Only

### `pg-writer.ts`

**`writeResourcesToPg(resources, tenantId, accountId, jobRunId)`**
- Deduplicates on `(resourceType, resourceId)` before writing
- Batch upsert 500 rows:
  ```sql
  INSERT INTO inventory_resources (tenantId, accountId, region, resourceType, resourceId,
    name, status, tags, metadata, jobRunId, discoveredAt, updatedAt)
  VALUES ($1, $2, ...)
  ON CONFLICT ("tenantId", "accountId", "resourceType", "resourceId")
  DO UPDATE SET name, status, tags, metadata, jobRunId, discoveredAt, updatedAt
  ```
- `extractMetadata(resource, resourceType)` — extracts type-specific fields from raw AWS data into JSONB (instance type, engine version, runtime, etc.). Covers 30+ resource types.
- Uses raw `pg` Pool (not Prisma) — matches scheduler worker pattern, keeps bundle size small

**`saveSyncStatus(scanId, tenantId, totalResources, accountsSynced)`**
- Upserts `inventory_sync_status` table with scan results

### `account-service.ts`

- `getAllTenants()` — queries `tenants` table for all active tenants (used by fan-out handler)
- `getTenantAccounts(tenantId)` — queries `accounts` table for active accounts belonging to a tenant
- `updateAccountSyncStatus(accountId, { lastSyncedAt, lastSyncStatus, lastSyncResourceCount })` — updates account record after scan

### `audit-service.ts`

- Writes to PostgreSQL `audit_logs` table (same table the rest of the platform uses)
- Events: `discovery.scan.started`, `discovery.scan.completed`, `discovery.scan.failed`
- Includes: tenantId, action, actor (`system`), metadata (scanId, accountCount, resourceCount, duration, errors)
- Uses the same audit repository pattern as the rest of the platform

### `sts-service.ts`

- `assumeRole(roleArn, externalId?)` → returns temporary credentials
- Session name: `NucleusDiscovery`, duration: 3600s
- Shared pattern with scheduler worker — can be extracted to `workers/src/shared/sts-service.ts`

---

## Worker Registration & Web-UI Integration

### `workers/src/jobs/discovery/index.ts`

```typescript
export async function register(boss: PgBoss): Promise<void> {
  // 1. Create queues
  await boss.createQueue('discovery-fan-out');
  await boss.createQueue('discovery-scan');

  // 2. Schedule daily cron (2 AM UTC)
  await boss.schedule('discovery-fan-out', '0 2 * * *', {}, { tz: 'UTC' });

  // 3. Fan-out handler
  await boss.work<DiscoveryFanOutJob>(
    'discovery-fan-out',
    { batchSize: 1 },
    async ([job]) => {
      const tenants = await getAllTenants();
      for (const tenant of tenants) {
        await boss.send('discovery-scan', {
          tenantId: tenant.id,
          triggeredBy: 'cron',
        }, {
          singletonKey: `tenant:${tenant.id}`,
          expireInHours: 2,
          retryLimit: 2,
          retryDelay: 60,
          retryBackoff: true,
        });
      }
    }
  );

  // 4. Scan handler
  await boss.work<DiscoveryScanJob>(
    'discovery-scan',
    { batchSize: 1 },
    async ([job]) => {
      const { tenantId, accountId, triggeredBy } = job.data;
      // orchestrate: audit start → scan accounts → pg upsert → sync status → audit complete
    }
  );
}
```

### `workers/src/index.ts`

```typescript
import { register as registerDiscoveryJobs } from './jobs/discovery';

await registerSchedulerJobs(boss);
await registerKbSyncJobs(boss);
await registerDiscoveryJobs(boss);  // new
```

### Web-UI API routes

**`POST /api/discovery/execute`** — trigger on-demand scan:
```typescript
const jobId = await boss.send('discovery-scan', {
  tenantId,
  accountId,          // optional — scan single account
  triggeredBy: 'web-ui',
  userEmail: email,
}, {
  singletonKey: `tenant:${tenantId}`,
  expireInHours: 2,
});
return NextResponse.json({ success: true, jobId });
```

**`GET /api/discovery/status`** — get sync status for tenant:
```typescript
const status = await getSyncStatus(tenantId);
return NextResponse.json({ success: true, data: status });
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection (shared with other workers) |
| `AWS_REGION` | Yes | `us-east-1` | Default region for STS client |
| `CONCURRENT_REGIONS` | No | `5` | p-limit for region fan-out |
| `CONCURRENT_SERVICES` | No | `10` | p-limit for service fan-out per region |
| `SCANFILE_PATH` | No | `./scanfile.json` | Custom scanfile path |

No DynamoDB table names, no S3 bucket names. The worker inherits `DATABASE_URL` from the same config the scheduler and kb-sync workers already use.

---

## Infrastructure Changes (Pulumi)

### Remove (after verification)

- Discovery ECS Fargate task definition
- Discovery execution role + task role
- Discovery security group
- Discovery log group (`/ecs/nucleus-cloud-ops-discovery`)
- Discovery ECR image reference (`discoveryImageUri` config)
- EventBridge schedule for discovery

### Add to workers task role

```
sts:AssumeRole → arn:aws:iam::*:role/NucleusAccess-*
```

Service-level permissions (ec2:Describe*, rds:Describe*, etc.) are on the assumed cross-account role, not the workers task role.

### Python cleanup

- Delete `lambda/discovery/` directory entirely
- Remove discovery-related resources from `infra/compute/index.ts`

---

## Testing Strategy

### Unit tests (`workers/src/jobs/discovery/__tests__/`)

| Test file | Coverage |
|-----------|----------|
| `scanner.test.ts` | `invokeService()` command name conversion, pagination, retry backoff; `applyEnrichments()` tags/describe/detail handlers; `normalizeResources()` string items, object items, ID extraction |
| `custom-scanners.test.ts` | EC2 reservation flattening, ECS nested services, WAFv2 dual-scope, CloudFront us-east-1 |
| `pg-writer.test.ts` | Batch upsert logic, deduplication, `extractMetadata()` for key resource types, `saveSyncStatus()` |
| `account-service.test.ts` | `getAllTenants()`, `getTenantAccounts()`, `updateAccountSyncStatus()` |
| `index.test.ts` | Fan-out sends one job per tenant, scan handler orchestrates correctly, singleton key prevents duplicates |

### Integration tests

- Mock AWS SDK clients (canned responses)
- Real PostgreSQL (Docker Compose)
- End-to-end: scanfile config → invoke → enrich → normalize → pg upsert → verify rows

### What we don't test

- Actual AWS API calls
- Every one of the 40 scanfile entries (generic engine — testing 3-4 representative configs covers the pattern)

---

## Local Development (`local-runner.ts`)

CLI runner for testing discovery outside pg-boss (mirrors Python `local_runner.py` + scheduler `local-runner.ts`):

```bash
# Direct mode — use current AWS credentials, scan ap-south-1
npx tsx src/jobs/discovery/local-runner.ts

# All accounts for a tenant
npx tsx src/jobs/discovery/local-runner.ts --tenant-id=org-abc123

# Single account
npx tsx src/jobs/discovery/local-runner.ts --account-id=123456789012

# Override regions and concurrency
npx tsx src/jobs/discovery/local-runner.ts --regions=us-east-1,ap-south-1 --concurrent-regions=3

# List scanfile entries and exit
npx tsx src/jobs/discovery/local-runner.ts --list-services

# Verbose logging
npx tsx src/jobs/discovery/local-runner.ts --verbose
```

The local runner calls the same `runInventoryScan()` and `writeResourcesToPg()` functions as the pg-boss handler — no separate code path.

---

## Key Invariants (carried from Python)

1. **Tenant isolation**: every resource row includes `tenantId` — never falls back to a default
2. **Tenant resolution**: if `tenantId` not on account record, skip account (never silently default)
3. **Global services**: CloudFront scanned only in `us-east-1`; WAFv2 scans both REGIONAL + CLOUDFRONT scopes in us-east-1
4. **Partial failure**: job marked failed if any account fails; successful accounts still written to PostgreSQL
5. **Audit bookends**: `discovery.scan.started` + `discovery.scan.completed` written to PostgreSQL audit_logs
6. **Retry backoff**: ThrottlingException / RequestLimitExceeded → exponential backoff, max 3 retries, base 2s delay
7. **Deduplication**: resources deduplicated on `(resourceType, resourceId)` before PostgreSQL batch write
8. **Singleton protection**: pg-boss `singletonKey` prevents concurrent scans for the same tenant

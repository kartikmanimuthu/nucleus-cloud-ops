---
title: Discovery Lambda — TypeScript Rewrite Design
date: 2026-04-04
status: approved
---

# Discovery Lambda — TypeScript Rewrite

## Overview

Rewrite `lambda/discovery/` (Python ECS Fargate task) to TypeScript in a new `lambda/discovery-ts/` directory. The rewrite is a 1:1 feature-parity port of the battle-tested Python implementation, following the aws-auto-inventory architecture: a single dynamic engine that calls any AWS API generically from a `scanfile.json` config. No per-service files. Adding a new service = one line in the service registry + one npm package.

**What changes:**
- Language: Python → TypeScript
- Persistence: DynamoDB + S3 + Iceberg → PostgreSQL only (inventory_resources + inventory_sync_status)
- Concurrency: ThreadPoolExecutor → Promise.all with p-limit
- Build: esbuild bundle (matches scheduler lambda pattern)

**What stays identical:**
- All scanning logic, deep scanners, normalization, metadata extraction
- scanfile.json format and all 40 service configs
- Audit log writes to DynamoDB NucleusAuditTable
- Account sync status updates on ACCOUNT# METADATA
- Local runner CLI flags and behavior
- Exit code 1 on partial failure

---

## Architecture

### Data Flow

```
index.ts
  → getActiveAccounts()         DynamoDB GSI1 query (or PostgreSQL if USE_PG_INVENTORY=true)
  → for each account:
      → getTenantIdForAccount()  DynamoDB ACCOUNT# METADATA lookup
      → runInventoryScan()       p-limit fan-out: regions × services
          → assumeRole()         STS AssumeRole with optional ExternalId
          → for each region (CONCURRENT_REGIONS parallel):
              → for each service (CONCURRENT_SERVICES parallel):
                  → DEEP_SCANNERS dispatch table (15 custom handlers)
                  → invokeService() generic: paginator-first → single call fallback → retry backoff
                  → normalizeResources() → Resource[]
      → writeResourcesToPg()     batch upsert 500, ON CONFLICT DO UPDATE, with jobRunId + discoveredAt
      → saveSyncStatus()         upsert inventory_sync_status
      → updateAccountSyncStatus() DynamoDB ACCOUNT# METADATA lastSyncedAt/Status/ResourceCount
      → writeAuditLog()          DynamoDB NucleusAuditTable
  → writeAuditLog() scan complete
  → process.exit(0 | 1)
```

### Removed vs Python

| Python | TypeScript |
|--------|-----------|
| S3 raw writes (`raw/`, `merged/`) | Removed |
| S3 normalized writes (`normalized/`) | Removed |
| S3 Tables / Iceberg / pyarrow / pandas | Removed |
| DynamoDB inventory writes | Removed |
| `_truncate_account_inventory()` | Removed |
| `mark_missing_resources()` | Removed |
| `config_generator.py` | Inlined into `scanner.ts` |
| `data_processor.py` | Split: scan logic → `scanner.ts`, persistence → `pg-writer.ts` |

---

## File Structure

```
lambda/discovery-ts/
├── src/
│   ├── index.ts            # Orchestrator — env validation, account loop, audit, exit code
│   ├── local-runner.ts     # tsx local dev runner — CLI flags
│   ├── types.ts            # All interfaces: Account, Resource, ScanConfig, ScanResult, AuditEntry
│   ├── scanner.ts          # THE engine: SERVICE_REGISTRY, DEEP_SCANNERS, invokeService,
│   │                       #   normalizeResources, extractResourceIdentifiers, runInventoryScan
│   ├── pg-writer.ts        # writeResourcesToPg, saveSyncStatus, extractMetadata (30+ resource types)
│   └── audit.ts            # writeAuditLog → DynamoDB NucleusAuditTable low-level put_item
├── scanfile.json           # Copied from Python — 40 service configs
├── package.json            # esbuild + tsx + @aws-sdk/* + p-limit + pg
├── tsconfig.json
├── Dockerfile              # node:20-slim, esbuild bundle, CMD node dist/index.js
└── .env.example
```

---

## Module Design

### `types.ts`

```typescript
interface ScanConfig {
  service: string;
  function: string;
  result_key?: string;
  parameters?: Record<string, unknown>;
}

interface Account {
  accountId: string;
  accountName?: string;
  roleArn?: string;
  externalId?: string;
  regions: string[];
  tenantId?: string;
}

interface Resource {
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

interface ScanResult {
  resources: Resource[];
  regionsScanned: number;
  servicesScanned: number;
  elapsedMs: number;
  error?: string;
}
```

### `scanner.ts`

**SERVICE_REGISTRY** — maps service name string → AWS SDK v3 client class. Only place that imports specific SDK packages. Adding a new service = one line here.

```typescript
const SERVICE_REGISTRY: Record<string, new (config: AwsCredentialIdentityProvider) => any> = {
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

**DEEP_SCANNERS** — dispatch table keyed by `"service:function"`. Mirrors Python's `if/elif` chain in `get_service_data()`:

| Key | Handler | Notes |
|-----|---------|-------|
| `ec2:describe_instances` | `flattenReservations` | Unwrap Reservations[].Instances[] |
| `ecs:list_clusters` | `ecsClusterDeep` | list → describe_clusters (batch 100) + TAGS |
| `ecs:list_services` | `ecsServicesDeep` | list clusters → list services → describe_services (batch 10) |
| `lambda:list_functions` | `lambdaDeep` | + list_tags per function → convert dict→list |
| `s3:list_buckets` | `s3Deep` | + get_bucket_tagging + get_bucket_location filter |
| `dynamodb:list_tables` | `dynamodbDeep` | + describe_table + list_tags_of_resource |
| `rds:describe_db_instances` | `rdsDeep` | + list_tags_for_resource per instance |
| `elbv2:describe_load_balancers` | `elbv2Deep` | + describe_tags batch 20 |
| `acm:list_certificates` | `acmDeep` | + list_tags_for_certificate + CertificateId injection |
| `apigateway:get_rest_apis` | `apigatewayDeep` | + get_tags + ARN construction |
| `kms:list_keys` | `kmsDeep` | + describe_key + list_resource_tags |
| `ecr:describe_repositories` | `ecrDeep` | + list_tags_for_resource |
| `cloudfront:list_distributions` | `cloudfrontDeep` | us-east-1 only, unwrap DistributionList.Items |
| `eks:list_clusters` | `eksDeep` | + describe_cluster per name |
| `wafv2:list_web_acls` | `wafv2Deep` | REGIONAL + CLOUDFRONT scopes |

**`invokeService()`** — generic engine for all services not in DEEP_SCANNERS:
1. Try paginator (SDK v3 paginateXxx helpers)
2. Fallback to single call if not pageable
3. Exponential backoff on ThrottlingException / RequestLimitExceeded (max 3 retries, base 2s)
4. Extract `result_key` from response
5. Return `{ region, service, function, result: any[] }`

**`runInventoryScan()`** — p-limit concurrency:
```typescript
const regionLimit = pLimit(CONCURRENT_REGIONS);   // default 5
const serviceLimit = pLimit(CONCURRENT_SERVICES); // default 10

// Ensure us-east-1 included when CloudFront in scanfile
// Fan out: regions × services
const allResults = await Promise.all(
  regions.map(region => regionLimit(() =>
    Promise.all(services.map(svc => serviceLimit(() =>
      invokeOrDeepScan(credentials, region, svc)
    )))
  ))
);
```

**`normalizeResources()`** — mirrors Python exactly:
- String items (ARNs, names): extract id from last `/` or `:` segment
- Dict items: call `extractResourceIdentifiers()`
- Resource type: `${service}_${function}` with `describe_/list_/get_` stripped

**`extractResourceIdentifiers()`** — mirrors Python's full id/arn/name/state/tags extraction with all known key patterns (InstanceId, DBInstanceIdentifier, FunctionName, clusterArn, repositoryName, CertificateId, etc.)

### `pg-writer.ts`

**`writeResourcesToPg(resources, tenantId, accountId, jobRunId, discoveredAt)`**
- Deduplicates on `(resourceType, resourceId)` before batching
- Batch upsert 500 rows: `ON CONFLICT ("tenantId", "accountId", "resourceType", "resourceId") DO UPDATE SET name, status, tags, metadata, "updatedAt"`
- Adds `jobRunId` and `discoveredAt` columns (new vs Python)
- `extractMetadata(resource, resourceType)` — all 30+ resource-type cases from Python's `_extract_metadata()`, returns `Record<string, unknown>` with null values stripped

**`saveSyncStatus(scanId, totalResources, accountsSynced)`**
- Upserts `inventory_sync_status` table: `ON CONFLICT ("scanId") DO UPDATE`

### `audit.ts`

Direct port of `audit_logger.py`:
- DynamoDB low-level `PutItemCommand`
- TTL: 90 days
- GSI keys: `LOG#<uuid>`, `TYPE#LOG`, `USER#system`, `EVENT#<eventType>`
- Silently skips if `AUDIT_TABLE_NAME` not set

### `local-runner.ts`

CLI flags (mirrors Python `local_runner.py` + scheduler `local-runner.ts`):

```
--mode=all-accounts          Fetch all active accounts from DynamoDB/PostgreSQL and scan
--account-id=<id>            Scan a single account
--regions=us-east-1,ap-south-1  Override regions
--concurrent-regions=3
--concurrent-services=5
--list-services              Print scanfile entries and exit
--verbose                    Debug logging
```

Direct mode (no `--mode` or `--account-id`): uses current AWS credentials, scans `--regions` (default `ap-south-1`).

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APP_TABLE_NAME` | Yes | — | DynamoDB app table (account lookup, sync status) |
| `AUDIT_TABLE_NAME` | No | — | DynamoDB audit table (skipped if unset) |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `AWS_REGION` | Yes | `us-east-1` | AWS region for DynamoDB clients |
| `SCAN_ID` | No | auto-generated | Job run ID stamped on every resource row |
| `CORRELATION_ID` | No | — | Passed through to audit logs |
| `ACCOUNT_ID` | No | — | Scan single account (skips DynamoDB account fetch) |
| `SCANFILE_PATH` | No | `./scanfile.json` | Custom scanfile path |
| `CONCURRENT_REGIONS` | No | `5` | p-limit for region fan-out |
| `CONCURRENT_SERVICES` | No | `10` | p-limit for service fan-out per region |
| `USE_PG_INVENTORY` | No | `true` | Always true in TS rewrite (no DynamoDB inventory path) |

---

## PostgreSQL Schema (existing tables)

```sql
-- inventory_resources (existing, unchanged)
ON CONFLICT ("tenantId", "accountId", "resourceType", "resourceId") DO UPDATE SET
  name, status, tags, metadata, "updatedAt"
-- New columns added: jobRunId TEXT, discoveredAt TIMESTAMPTZ

-- inventory_sync_status (existing)
ON CONFLICT ("scanId") DO UPDATE SET
  "totalResources", "accountsSynced", "syncedAt"
```

---

## Build & Deployment

```bash
# Build
npm run build   # esbuild src/index.ts → dist/index.js (externals: @aws-sdk/*, pg)

# Local dev
npm run dev                                    # direct mode, ap-south-1
npm run dev -- --mode=all-accounts             # all accounts from DynamoDB
npm run dev -- --account-id=123456789012       # single account
npm run dev -- --list-services                 # print scanfile

# Docker
docker build -t discovery-ts .
docker run --env-file .env discovery-ts
```

**Dockerfile:**
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
COPY scanfile.json ./
CMD ["node", "dist/index.js"]
```

---

## Key Invariants (from Python)

1. **Tenant isolation**: every resource row includes `tenantId` — never falls back to a default
2. **Tenant resolution**: if `tenantId` not on account record, look up via `ACCOUNT# METADATA` — skip account on failure (never silently default)
3. **Global services**: CloudFront scanned only in `us-east-1`; WAFv2 scans both REGIONAL + CLOUDFRONT scopes in us-east-1
4. **Partial failure**: exit code 1 if any account fails; successful accounts still written
5. **Audit bookends**: `inventory.vector_embedding.started` + `inventory.vector_embedding.completed` + `discovery.scan.completed` written to NucleusAuditTable
6. **Retry backoff**: ThrottlingException / RequestLimitExceeded → exponential backoff, max 3 retries, base 2s delay
7. **Deduplication**: resources deduplicated on `(resourceType, resourceId)` before PostgreSQL batch write

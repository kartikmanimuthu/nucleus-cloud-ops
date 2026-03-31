---
phase: 09-lambda-eventbridge
created: 2026-03-30
status: ready
---

# Phase 9: Lambda + EventBridge — Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Deploy all Lambda functions (Scheduler, VectorProcessor, KBSyncProcessor) and the Discovery ECS task definition with correct triggers, IAM roles, and env vars wired from Phase 8 stack outputs.

Also includes:
- SNS topic for scheduler alerts
- S3 BucketNotification wiring InventoryBucket → VectorProcessingQueue (normalized/ prefix)
- Discovery task definition + IAM roles + EventBridge Rule (StartDiscovery on-demand)
- Pre-build script for TypeScript Lambdas

**Explicitly deferred to Phase 10:**
- EventBridge Scheduler for daily Discovery (needs ECS cluster ARN from Phase 10)
- ECS cluster, ALB, CloudFront, web UI container

</domain>

<decisions>
## Implementation Decisions

### Lambda Build Approach — LOCKED

**Decision:** Pre-build script (`infra/build-lambdas.sh`) runs esbuild for each TypeScript Lambda before `pulumi up`. Plan includes a task: "run build-lambdas.sh, then pulumi up".

**Script builds:**
1. `lambda/scheduler/` → `lambda/scheduler/dist/index.js` (existing `npm run build` via esbuild)
2. `lambda/vector_processor/src/index.ts` → `lambda/vector_processor/dist/index.js` (esbuild)
3. `lambda/kb_sync_processor/src/index.ts` → `lambda/kb_sync_processor/dist/index.js` (tsc or esbuild)

**Pulumi Lambda code:** `aws.lambda.Function` with `code: new pulumi.asset.FileArchive("../../lambda/scheduler/dist")` (or equivalent zip).

**Note:** CDK's `NodejsFunction` bundles to a single file. Pulumi needs the same — esbuild `--bundle --platform=node --target=node20` output to a single `index.js`, then zip it. The build script must produce a zip file per Lambda.

### File Organization — LOCKED (carry-forward from Phase 8)

All resources go in `infra/compute/index.ts` — single file, no splits.

### Discovery ECS Task Scope — LOCKED

**Phase 9 includes:**
- Discovery ECS task definition (ARM64, Python container)
- Discovery task IAM role (cross-account STS, DynamoDB, S3, S3Tables)
- Discovery ECS task execution role
- Discovery security group
- EventBridge Rule: `nucleus-cloud-ops-discovery-trigger-rule` (source=`nucleus.app`, detailType=`StartDiscovery`)

**Phase 10 adds:**
- EventBridge Scheduler (`nucleus-cloud-ops-daily-discovery`) — needs `ecsCluster.arn`
- Scheduler IAM role for ECS RunTask

**Rationale:** Task definition can be created without a cluster ARN. The EventBridge Scheduler target requires `Arn: ecsCluster.clusterArn` which doesn't exist until Phase 10.

### S3 BucketNotification — LOCKED

**Decision:** Add `aws.s3.BucketNotification` in Phase 9 alongside VectorProcessor Lambda.

**Resource:** `aws.s3.BucketNotification` on `inventoryBucket` (imported from Phase 8 stack output `inventoryBucketName`):
- event: `s3:ObjectCreated:*`
- filter prefix: `normalized/`
- destination: `vectorProcessingQueue` ARN (from Phase 8 stack output `vectorProcessingQueueArn`)

**Important:** Pulumi's `aws.s3.BucketNotification` requires the bucket to already exist (Phase 8). The notification resource references the bucket by name/ARN from stack outputs.

### SNS Topic — LOCKED

**Decision:** Include SNS topic + email subscriptions in Phase 9 alongside Scheduler Lambda.

**Resource:** `aws.sns.Topic` with physical name `nucleus-cloud-ops-sns-topic`.

**Email subscriptions:** Read from Pulumi config key `nucleus-compute:subscriptionEmails` (comma-separated list). If empty/unset, create topic with no subscriptions.

**Scheduler Lambda env var:** `SNS_TOPIC_ARN: snsTopic.arn`

### Resource Naming — Match CDK Exactly

**Lambda functions:**
| Lambda | Physical Name | Entry |
|--------|--------------|-------|
| SchedulerLambda | `nucleus-cloud-ops-function` | `lambda/scheduler/dist/index.js` |
| VectorProcessor | `nucleus-cloud-ops-vector-processor` | `lambda/vector_processor/dist/index.js` |
| KBSyncProcessor | `nucleus-cloud-ops-kb-sync-processor` | `lambda/kb_sync_processor/dist/index.js` |

**IAM roles:**
| Role | Physical Name |
|------|--------------|
| SchedulerLambdaRole | `nucleus-cloud-ops-lambda-role` (CDK uses timestamp suffix — use stable name in Pulumi) |
| VectorProcessorRole | `nucleus-cloud-ops-vector-processor-role` |
| KBSyncProcessorRole | `nucleus-cloud-ops-kb-sync-processor-role` |
| DiscoveryTaskRole | `nucleus-cloud-ops-discovery-task-role` |
| DiscoveryExecutionRole | `nucleus-cloud-ops-discovery-execution-role` |
| DiscoverySchedulerRole | `nucleus-cloud-ops-discovery-scheduler-role` (Phase 10 only) |

**EventBridge:**
| Resource | Physical Name |
|----------|--------------|
| SchedulerTriggerRule | `nucleus-cloud-ops-rule` |
| DiscoveryTriggerRule | `nucleus-cloud-ops-discovery-trigger-rule` |
| SNS Topic | `nucleus-cloud-ops-sns-topic` |

**Security Group:**
| Resource | Name tag |
|----------|----------|
| DiscoverySG | `nucleus-cloud-ops-discovery-sg` |

### Lambda Runtime Configuration — Match CDK Exactly

All 3 TypeScript Lambdas:
- `runtime: "nodejs20.x"`
- `architectures: ["arm64"]`
- `timeout: 900` (15 minutes)
- `memorySize: 1024`

**VectorProcessor additional:**
- `reservedConcurrentExecutions: 10` (limits Bedrock throttling)

**Scheduler Lambda env vars:**
```
APP_TABLE_NAME: appTableName (from Phase 8 output)
AUDIT_TABLE_NAME: auditTableName (from Phase 8 output)
CROSS_ACCOUNT_ROLE_ARN: schedulerLambdaRole.arn
SCHEDULER_TAG: "cost-optimization-scheduler"
SNS_TOPIC_ARN: snsTopic.arn
HUB_ACCOUNT_ID: callerIdentity.accountId
NEXT_PUBLIC_HUB_ACCOUNT_ID: callerIdentity.accountId
```

**VectorProcessor env vars:**
```
INVENTORY_BUCKET_NAME: inventoryBucketName (from Phase 8 output)
VECTOR_BUCKET_NAME: vectorBucketName (from Phase 8 output — S3 Vectors, deferred to Phase 11)
VECTOR_BUCKET_ARN: vectorBucketArn (from Phase 8 output)
VECTOR_INDEX_NAME: "text-embeddings"
BEDROCK_MODEL_ID: "amazon.titan-embed-text-v2:0"
APP_TABLE_NAME: appTableName (from Phase 8 output)
AUDIT_TABLE_NAME: auditTableName (from Phase 8 output)
```

**Note on VECTOR_BUCKET_NAME:** S3 Vectors bucket is deferred to Phase 11. For Phase 9, use a placeholder value from Pulumi config (`nucleus-compute:vectorBucketName`) or leave as empty string — VectorProcessor won't be invoked until Phase 11 wires the real bucket.

**KBSyncProcessor env vars:**
```
APP_TABLE_NAME: appTableName (from Phase 8 output)
KB_VECTOR_BUCKET_NAME: vectorBucketName (placeholder — Phase 11)
KB_VECTOR_INDEX_NAME: "knowledge-base-embeddings"
KB_STAGING_BUCKET_NAME: kbStagingBucketName (from Phase 8 output)
BEDROCK_MODEL_ID: "amazon.titan-embed-text-v2:0"
```

### Scheduler Lambda EventBridge Rule — Match CDK Exactly

CDK uses `cron(0,30 * * * ? *)` for 30-minute interval.

Pulumi: `aws.cloudwatch.EventRule` with `scheduleExpression: "cron(0,30 * * * ? *)"`.
Add `aws.cloudwatch.EventTarget` pointing to Scheduler Lambda ARN.
Add `aws.lambda.Permission` allowing `events.amazonaws.com` to invoke the Lambda.

### SQS Event Sources — Match CDK Exactly

**VectorProcessor:**
- `aws.lambda.EventSourceMapping` on `vectorProcessingQueueArn`
- `batchSize: 1`
- `scalingConfig: { maximumConcurrency: 5 }`

**KBSyncProcessor:**
- `aws.lambda.EventSourceMapping` on `kbSyncQueueArn`
- `batchSize: 1`

### Discovery ECS Task Definition — Match CDK Exactly

- `family: "nucleus-cloud-ops-discovery"` (task family name)
- `cpu: "256"`, `memory: "512"`
- `networkMode: "awsvpc"`
- `requiresCompatibilities: ["FARGATE"]`
- `runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" }`
- Container: `DiscoveryContainer`, image from ECR (same image as CDK — read from Pulumi config `nucleus-compute:discoveryImageUri`)
- Container env vars: `APP_TABLE_NAME`, `AUDIT_TABLE_NAME`, `INVENTORY_BUCKET_NAME`, `AWS_REGION`, `CROSS_ACCOUNT_ROLE_NAME`

**Discovery task IAM permissions:**
- `sts:AssumeRole` on `arn:aws:iam::*:role/NucleusAccess-*` and `arn:aws:iam::*:role/${CROSS_ACCOUNT_ROLE_NAME}`
- DynamoDB read/write on AppTable, AuditTable, InventoryTable
- S3 read/write on InventoryBucket
- S3Tables full access (`s3tables:*`)
- CloudWatch Logs

### Stack Outputs — Phase 9 Additions

Export from Phase 9:
- `schedulerLambdaArn` — needed by Phase 10 (ECS env var)
- `vectorProcessorArn` — informational
- `kbSyncProcessorArn` — informational
- `discoveryTaskDefinitionArn` — needed by Phase 10 (EventBridge Scheduler target)
- `discoveryTaskRoleArn` — needed by Phase 10 (Scheduler IAM PassRole)
- `discoveryExecutionRoleArn` — needed by Phase 10 (Scheduler IAM PassRole)
- `discoverySecurityGroupId` — needed by Phase 10 (Scheduler network config)
- `snsTopicArn` — informational

### Pulumi Config Additions

Add to `infra/compute/Pulumi.prod.yaml`:
```yaml
nucleus-compute:subscriptionEmails: ""  # comma-separated, e.g. "ops@example.com"
nucleus-compute:discoveryImageUri: ""   # ECR image URI for discovery container
nucleus-compute:crossAccountRoleName: "NucleusAccess"  # matches CDK CROSS_ACCOUNT_ROLE_NAME
nucleus-compute:vectorBucketName: ""    # placeholder until Phase 11
```

### Claude's Discretion

- Exact zip packaging approach for Lambda code (FileArchive vs AssetArchive)
- Whether to use `pulumi.all()` or individual `apply()` for env var wiring
- IAM policy document structure (inline vs separate PolicyDocument)
- Log group creation for Lambda functions (CloudWatch auto-creates, but explicit is cleaner)

</decisions>

<specifics>
## Specific Requirements

- CDK's `lambdaRoleName` uses `${timestamp}-${randomSuffix}` — this is a CDK anti-pattern that causes role recreation on every deploy. Pulumi should use a stable name: `nucleus-cloud-ops-lambda-role`.
- The `CROSS_ACCOUNT_ROLE_ARN` env var on Scheduler Lambda should be the Lambda's own execution role ARN (CDK passes `lambdaRole.roleArn`) — this is the role the Lambda assumes when making cross-account calls.
- S3 BucketNotification must be a separate `aws.s3.BucketNotification` resource (not inline on the bucket) since the bucket was created in Phase 8.
- Discovery container image URI is not in the CDK source (it's built separately) — use Pulumi config placeholder.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### CDK Source of Truth
- `lib/computeStack.ts` — Lines 555–700 (VectorProcessor, KBSyncProcessor, SNS, Scheduler Lambda, EventBridge rule), Lines 1060–1240 (Discovery task def, IAM, EventBridge Scheduler + Rule)

### Lambda Source
- `lambda/scheduler/src/index.ts` — Scheduler Lambda handler (understand env vars consumed)
- `lambda/scheduler/package.json` — Build script (`npm run build` → esbuild)
- `lambda/vector_processor/src/index.ts` — VectorProcessor handler
- `lambda/kb_sync_processor/src/index.ts` — KBSyncProcessor handler

### Prior Phase Context
- `.planning/phases/08-data-layer/08-CONTEXT.md` — Stack output names (appTableName, auditTableName, inventoryBucketName, vectorProcessingQueueArn, kbSyncQueueArn, kbStagingBucketName)
- `.planning/phases/07-networking/07-CONTEXT.md` — Established patterns: explicit physical names, Pulumi config pattern

### Requirements
- `.planning/REQUIREMENTS.md` — PULUMI-08 through PULUMI-11 define acceptance criteria for this phase

### Existing Compute Stack
- `infra/compute/index.ts` — Current state after Phase 8 (all data layer resources + 31 stack outputs)
- `infra/compute/Pulumi.prod.yaml` — Stack config — Phase 9 adds 4 new config keys

</canonical_refs>

<code_context>
## Existing Code Insights

### Phase 8 Stack Outputs Available
All Phase 9 Lambda env vars can be wired from Phase 8 outputs already in `infra/compute/index.ts`:
- `appTableName`, `auditTableName`, `inventoryBucketName`, `kbStagingBucketName`
- `vectorProcessingQueueArn`, `kbSyncQueueArn`
- `vectorBucketName` (placeholder — Phase 11 wires real S3 Vectors bucket)

### Lambda Build Pattern
`lambda/scheduler/` already has esbuild configured via `package.json` `build` script. The pre-build script should reuse this pattern for all 3 Lambdas.

### Integration Points
- Phase 9 resources reference Phase 8 outputs via local variables (same `index.ts` file — no StackReference needed)
- Phase 10 will reference Phase 9 outputs: `schedulerLambdaArn` (ECS env var), `discoveryTaskDefinitionArn` + `discoveryTaskRoleArn` + `discoveryExecutionRoleArn` + `discoverySecurityGroupId` (EventBridge Scheduler target)

</code_context>

<deferred>
## Deferred Ideas

- **EventBridge Scheduler for daily Discovery** (`nucleus-cloud-ops-daily-discovery`) — deferred to Phase 10; needs `ecsCluster.arn` which doesn't exist until Phase 10
- **Discovery Scheduler IAM role** (`nucleus-cloud-ops-discovery-scheduler-role`) — deferred to Phase 10 with the scheduler
- **S3 Vectors bucket wiring** for VectorProcessor and KBSyncProcessor — deferred to Phase 11; placeholder config values used in Phase 9

</deferred>

---

*Phase: 09-lambda-eventbridge*
*Context gathered: 2026-03-30*

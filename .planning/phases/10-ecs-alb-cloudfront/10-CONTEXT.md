---
phase: 10-ecs-alb-cloudfront
created: 2026-03-30
status: ready
---

# Phase 10: ECS + ALB + CloudFront — Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Deploy the ECS Fargate cluster, WebUI task definition + service, ALB, CloudFront distribution, auto scaling, and the deferred EventBridge Scheduler for daily Discovery (needs cluster ARN — deferred from Phase 9).

Also includes:
- ECR repository + build script for WebUI container image
- ECS task execution role + task role with all required IAM permissions
- ALB with HTTP listener + health check on `/api/health`
- CloudFront distribution with `random.RandomString` origin verify secret
- Auto scaling (CPU 70% + Memory 75%)
- EventBridge Scheduler (`nucleus-cloud-ops-daily-discovery`, cron 2AM UTC) + Scheduler IAM role

**Explicitly deferred to Phase 11:**
- Wiring `web-ui/.env.local` from `pulumi stack output`
- CDK NetworkingStack + ComputeStack destruction
- S3 Vectors + S3 Tables CloudFormation wrapping

</domain>

<decisions>
## Implementation Decisions

### Container Image Build — LOCKED

**Decision:** Add `infra/build-images.sh` script that builds the WebUI Docker image and pushes to ECR. Plan includes a task to run this before `pulumi up`. Image URI stored in Pulumi config `nucleus-compute:webUiImageUri`.

**Script steps:**
1. Create ECR repository if it doesn't exist: `nucleus-cloud-ops-web-ui`
2. `docker build -f web-ui/Dockerfile.ecs --platform linux/arm64 -t <ecr-uri>:latest web-ui/`
3. `docker push <ecr-uri>:latest`
4. Output the full image URI for use in Pulumi config

**ECR repository name:** `nucleus-cloud-ops-web-ui`

**Pulumi config key:** `nucleus-compute:webUiImageUri` — executor sets this after running the build script, before `pulumi up`.

**Note:** CDK used `ContainerImage.fromAsset` which auto-builds at synth time. Pulumi requires a pre-existing image URI. The build script replaces this CDK behavior.

### CloudFront — LOCKED

**Decision:** Deploy CloudFront distribution in front of ALB per PULUMI-15. Use `random.RandomString` for origin verify secret (stable, not `crypto.randomBytes` which changes on every deploy).

**Architecture:**
- CloudFront → ALB (HTTP, port 80) via custom origin
- Origin verify secret: `random.RandomString` resource, 32 chars, stored as Pulumi secret output
- ALB security group: restrict inbound port 80 to CloudFront managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`) + custom header check
- Caching: disabled (all requests forwarded to ALB)
- CloudFront URL exported as `cloudFrontUrl` stack output

**Note:** CDK has CloudFront commented out — Pulumi implements it fresh per REQUIREMENTS.md.

### File Organization — LOCKED (carry-forward)

All resources go in `infra/compute/index.ts` — single file, no splits.

### ECS Service Desired Count — Claude's Discretion

Start with `desiredCount: 0` (safe — service deployed but not running). Matches CDK default (`ecsConfig.webUi?.desiredCount || 0`). Can be scaled up manually after smoke testing.

### Discovery Task CPU/Memory — Claude's Discretion

CDK uses cpu=1024/memory=2048 for Discovery task. Phase 9 deployed 256/512. When Phase 10 adds the EventBridge Scheduler, update the task definition to match CDK: cpu=1024, memory=2048. The task definition ARN will change — Phase 10 Scheduler target must reference the updated ARN.

### Resource Naming — Match CDK Exactly

**ECS:**
| Resource | Physical Name |
|----------|--------------|
| ECS Cluster | `nucleus-cloud-ops-ecs-cluster` |
| WebUI Task Family | `nucleus-cloud-ops-web-ui-task` |
| WebUI Service | `nucleus-cloud-ops-web-ui-service` |
| WebUI Log Group | `/ecs/nucleus-cloud-ops-web-ui-service` |
| ECS Task Execution Role | `nucleus-cloud-ops-ecs-execution-role` |
| ECS Task Role | `nucleus-cloud-ops-ecs-task-role` |

**ALB:**
| Resource | Physical Name |
|----------|--------------|
| ALB | `nucleus-cloud-ops-alb` |
| Target Group | `nucleus-cloud-ops-web-ui-tg` (max 32 chars) |

**CloudFront:**
| Resource | Physical Name |
|----------|--------------|
| Origin verify secret | `random.RandomString`, 32 chars, stored as `pulumi.secret()` |

**EventBridge Scheduler (Discovery):**
| Resource | Physical Name |
|----------|--------------|
| Daily Discovery Schedule | `nucleus-cloud-ops-daily-discovery` |
| Scheduler IAM Role | `nucleus-cloud-ops-discovery-scheduler-role` |

**ECR:**
| Resource | Physical Name |
|----------|--------------|
| WebUI Repository | `nucleus-cloud-ops-web-ui` |

### ECS Task Definition — Match CDK Exactly

**WebUI task:**
- `cpu: 512`, `memory: 1024` (CDK defaults: `ecsConfig.webUi?.cpu || 512`, `memory || 1024`)
- `runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" }`
- Container port: 3000
- Log driver: awslogs → `/ecs/nucleus-cloud-ops-web-ui-service`, stream prefix `web-ui`

**Container env vars (30+) — all wired from Phase 8/9 stack outputs via `pulumi.all()`:**
```
NODE_ENV: "production"
PORT: "3000"
AWS_REGION: region
NEXT_PUBLIC_AWS_REGION: region
NEXT_PUBLIC_HUB_ACCOUNT_ID: accountId
HUB_ACCOUNT_ID: accountId
APP_TABLE_NAME: appTableName (Phase 8 output)
NEXT_PUBLIC_APP_TABLE_NAME: appTableName
AUDIT_TABLE_NAME: auditTableName (Phase 8 output)
NEXT_PUBLIC_AUDIT_TABLE_NAME: auditTableName
DYNAMODB_CHECKPOINT_TABLE: checkpointTableName (Phase 8 output)
DYNAMODB_WRITES_TABLE: writesTableName (Phase 8 output)
CHECKPOINT_S3_BUCKET: checkpointBucketName (Phase 8 output)
DYNAMODB_CHAT_HISTORY_TABLE: chatHistoryTableName (Phase 8 output)
DYNAMODB_MEMORY_TABLE: memoryTableName (Phase 8 output)
DYNAMODB_USERS_TEAMS_TABLE: usersTeamsTableName (Phase 8 output)
COGNITO_USER_POOL_ID: cognitoUserPoolId (Phase 8 output)
NEXT_PUBLIC_COGNITO_USER_POOL_ID: cognitoUserPoolId
COGNITO_USER_POOL_CLIENT_ID: cognitoUserPoolClientId (Phase 8 output)
NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID: cognitoUserPoolClientId
COGNITO_CLIENT_SECRET: cognitoUserPoolClientSecret (Phase 8 output — secret)
COGNITO_DOMAIN: pulumi.interpolate`nucleus-cloud-ops-web-ui-auth-${accountId}.auth.${region}.amazoncognito.com`
NEXT_PUBLIC_COGNITO_DOMAIN: same
COGNITO_REGION: region
NEXT_PUBLIC_COGNITO_REGION: region
COGNITO_IDENTITY_POOL_ID: cognitoIdentityPoolId (Phase 8 output)
NEXT_PUBLIC_COGNITO_IDENTITY_POOL_ID: cognitoIdentityPoolId
NEXTAUTH_URL: appUrl (Pulumi config)
NEXT_PUBLIC_NEXTAUTH_URL: appUrl
NEXTAUTH_SECRET: from Pulumi config (nucleus-compute:nextauthSecret)
COGNITO_ISSUER: pulumi.interpolate`https://cognito-idp.${region}.amazonaws.com/${cognitoUserPoolId}`
NEXT_PUBLIC_COGNITO_ISSUER: same
AWS_LAMBDA_EXECUTION_ROLE_ARN: ecsTaskRole.arn
NEXT_PUBLIC_AWS_LAMBDA_EXECUTION_ROLE_ARN: ecsTaskRole.arn
AWS_USE_STS: "true"
NEXT_PUBLIC_AWS_USE_STS: "true"
COGNITO_APP_CLIENT_ID: cognitoUserPoolClientId
COGNITO_APP_CLIENT_SECRET: cognitoUserPoolClientSecret (secret)
DATA_DIR: "/tmp"
SCHEDULER_LAMBDA_ARN: schedulerLambdaArn (Phase 9 output)
EVENTBRIDGE_RULE_NAME: "nucleus-cloud-ops-rule"
AGENT_TEMP_BUCKET: agentTempBucketName (Phase 8 output)
AGENT_OPS_TABLE_NAME: agentOpsTableName (Phase 8 output)
INVENTORY_BUCKET_NAME: inventoryBucketName (Phase 8 output)
INVENTORY_TABLE_NAME: inventoryTableName (Phase 8 output)
VECTOR_BUCKET_NAME: vectorBucketName (placeholder — Phase 11)
VECTOR_INDEX_NAME: "text-embeddings"
BEDROCK_MODEL_ID: "amazon.titan-embed-text-v2:0"
KB_VECTOR_BUCKET_NAME: vectorBucketName (placeholder — Phase 11)
KB_VECTOR_INDEX_NAME: "knowledge-base-embeddings"
KB_SYNC_QUEUE_URL: kbSyncQueueUrl (Phase 8 output)
KB_STAGING_BUCKET_NAME: kbStagingBucketName (Phase 8 output)
ASK_AI_GENERATION_MODEL: "global.anthropic.claude-sonnet-4-6"
LANGFUSE_ENABLED: "false"
LANGFUSE_PUBLIC_KEY: ""
LANGFUSE_SECRET_KEY: ""
LANGFUSE_HOST: "https://cloud.langfuse.com"
```

### ECS Task Role IAM Permissions — Match CDK

The ECS task role needs:
- DynamoDB read/write on all tables (AppTable, AuditTable, InventoryTable, UsersTeamsTable, CheckpointTable, WritesTable, ChatHistoryTable, MemoryTable, AgentOpsTable)
- S3 read/write on CheckpointBucket, AgentTempBucket, InventoryBucket, KBStagingBucket
- SQS SendMessage on KBSyncQueue
- Bedrock InvokeModel (`*`)
- STS AssumeRole on `arn:aws:iam::*:role/NucleusAccess-*`
- S3Vectors: QueryVectors, PutVectors, DeleteVectors, GetVectors, ListVectorIndices (placeholder ARNs — Phase 11)
- CloudWatch Logs

### ALB Configuration — Match CDK Exactly

- `internetFacing: true`
- `idleTimeout: 1200` (20 minutes — supports long streaming requests)
- HTTP listener on port 80
- Target group: port 3000, protocol HTTP, targetType IP
- Health check: path `/api/health`, interval 60s, timeout 5s, healthy=2, unhealthy=3
- Deregistration delay: 30s

### Auto Scaling — Match CDK Exactly

- minCapacity: 2, maxCapacity: 10
- CPU scaling: targetUtilizationPercent=70
- Memory scaling: targetUtilizationPercent=75

### EventBridge Scheduler (Discovery) — Match CDK Exactly

Deferred from Phase 9 — needs `ecsCluster.arn`.

- Schedule: `cron(0 2 * * ? *)` (daily 2AM UTC)
- Target: ECS cluster ARN, task definition ARN, FARGATE launch type
- Network config: private subnets from networking stack, discovery security group, no public IP
- Scheduler IAM role: `nucleus-cloud-ops-discovery-scheduler-role`
  - `ecs:RunTask` on discovery task definition ARN
  - `iam:PassRole` on discovery task role ARN + execution role ARN

### Pulumi Config Additions

Add to `infra/compute/Pulumi.prod.yaml`:
```yaml
nucleus-compute:webUiImageUri: ""        # set after running infra/build-images.sh
nucleus-compute:nextauthSecret: "change-in-production"
```

### Stack Outputs — Phase 10 Additions

Export:
- `ecsClusterArn` — informational
- `ecsClusterName` — informational
- `webUiServiceName` — informational
- `albDnsName` — ALB DNS name
- `cloudFrontUrl` — CloudFront distribution URL (primary app URL)
- `cloudFrontDistributionId` — for cache invalidation
- `ecrRepositoryUri` — for build script reference

</decisions>

<specifics>
## Specific Requirements

- `NEXTAUTH_SECRET` must come from Pulumi config (not hardcoded) — CDK has a placeholder string but Pulumi should use `config.requireSecret("nextauthSecret")` so it's encrypted in state
- CloudFront origin verify secret must use `random.RandomString` (not `crypto.randomBytes`) — `crypto.randomBytes` generates a new value on every `pulumi preview`, causing CloudFront to update on every deploy
- `forceNewDeployment: true` on ECS service — ECS does not redeploy on task definition update without this (from STATE.md decisions)
- ALB security group should restrict inbound to CloudFront managed prefix list — prevents direct ALB access bypassing CloudFront
- Discovery task definition update: change cpu from 256→1024, memory from 512→2048 to match CDK (Phase 9 deployed wrong values)

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### CDK Source of Truth
- `lib/computeStack.ts` — Lines 908–1122 (ECS cluster, task def, container env vars, ALB, auto scaling), Lines 1172–1240 (Discovery EventBridge Scheduler)

### Prior Phase Context
- `.planning/phases/09-lambda-eventbridge/09-CONTEXT.md` — Phase 9 stack outputs (schedulerLambdaArn, discoveryTaskDefinitionArn, discoveryTaskRoleArn, discoveryExecutionRoleArn, discoverySecurityGroupId)
- `.planning/phases/08-data-layer/08-CONTEXT.md` — Phase 8 stack output names (all table names, bucket names, queue URLs, Cognito IDs)
- `.planning/phases/07-networking/07-CONTEXT.md` — Networking stack outputs (privateSubnetIds, vpcId)

### Requirements
- `.planning/REQUIREMENTS.md` — PULUMI-12 through PULUMI-15 define acceptance criteria for this phase

### Existing Compute Stack
- `infra/compute/index.ts` — Current state after Phase 9 (all data layer + Lambda resources)
- `infra/compute/Pulumi.prod.yaml` — Stack config — Phase 10 adds webUiImageUri + nextauthSecret

</canonical_refs>

<code_context>
## Existing Code Insights

### Phase 8/9 Stack Outputs Available
All 30+ container env vars can be wired from existing stack outputs already in `infra/compute/index.ts`. No new data resources needed — Phase 10 is pure compute.

### Integration Points
- `vpcId`, `privateSubnetIds`, `publicSubnetIds` from networking StackReference (already in index.ts)
- All Phase 8 table/bucket/queue outputs (already exported in index.ts)
- Phase 9 Lambda ARNs (schedulerLambdaArn, discoveryTaskDefinitionArn, etc.) — already exported

### Discovery Task Definition Update
Phase 9 created the discovery task definition with cpu=256/memory=512. Phase 10 must update it to cpu=1024/memory=2048. In Pulumi, this means changing the resource properties — Pulumi will create a new task definition revision automatically (ECS task definitions are immutable; new revision = new ARN). The EventBridge Scheduler target in Phase 10 must reference the updated ARN.

</code_context>

<deferred>
## Deferred Ideas

- **HTTPS/TLS on ALB** — CDK has it commented out; keeping HTTP-only for now
- **Custom domain** — CDK has customDomainConfig support; not in scope for v2.0
- **S3 Vectors wiring** — VECTOR_BUCKET_NAME placeholder until Phase 11
- **Langfuse observability** — env vars present but LANGFUSE_ENABLED=false; real keys deferred

</deferred>

---

*Phase: 10-ecs-alb-cloudfront*
*Context gathered: 2026-03-30*

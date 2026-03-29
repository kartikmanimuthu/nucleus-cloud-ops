# Feature Landscape: Pulumi IaC Migration

**Domain:** CDK-to-Pulumi TypeScript rewrite (NetworkingStack + ComputeStack)
**Researched:** 2026-03-29
**Source:** Direct analysis of lib/networkingStack.ts and lib/computeStack.ts

---

## Table Stakes

Features that must exist for the migration to be considered complete. Missing any = the platform doesn't run.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Pulumi project scaffold (S3 backend + DynamoDB lock) | All state must be stored; concurrent deploys need locking | Low | `pulumi login s3://...`; DynamoDB table for state locking |
| NetworkingStack parity: VPC, 4-tier subnets, NAT, IGW | ECS, ALB, RDS all depend on this VPC | Medium | 4 subnet tiers: Public/Private/Database/Intra; cidrMask per tier must match CDK |
| VPC Gateway Endpoints (S3 + DynamoDB) | Free; Lambda/ECS traffic stays off public internet | Low | Both are gateway type — no interface endpoint cost |
| RDS + ElastiCache subnet groups | Required by v1.0 PostgreSQL (RDS) and any future ElastiCache | Low | CfnDBSubnetGroup + CfnSubnetGroup equivalents |
| NetworkingStack outputs (VpcId, subnet IDs, AZs) | ComputeStack consumes these via StackReference | Low | Must export same logical names CDK used |
| Cross-stack reference (StackReference) | ComputeStack takes `vpc` from NetworkingStack | Low | Pulumi `StackReference` replaces CDK prop passing |
| 9 DynamoDB tables with correct schemas + GSIs | App, Audit, Inventory, UsersTeams, Checkpoint, Writes, ChatHistory, Memory, AgentOps | High | AppTable/AuditTable/InventoryTable each have 3 GSIs; TTL attributes must match exactly |
| 4 S3 buckets with lifecycle rules | Checkpoint (30d), AgentTemp (1d), Inventory (raw 365d/exports 7d), KBStaging (1d) | Low | Bucket names include account+region suffix — use `pulumi.interpolate` |
| SQS queues + DLQs (VectorProcessing + KBSync) | Lambda event sources; DLQ for retry handling | Low | visibilityTimeout must be >= Lambda timeout (900s) |
| CloudWatch alarm on VectorProcessingDLQ | Alerts on failed vector processing | Low | threshold=1, evaluationPeriods=1 |
| SNS topic with email subscriptions | Scheduler Lambda notifications | Low | Email list from config |
| Scheduler Lambda (ARM64, Node 20, esbuild) | Core resource scheduling feature | Medium | esbuild bundling must happen before Pulumi asset upload; external: `@aws-sdk/*` |
| VectorProcessor Lambda (ARM64, Node 20, esbuild) | Inventory vector indexing pipeline | Medium | SQS event source, batchSize=1, maxConcurrency=5 |
| KBSyncProcessor Lambda (ARM64, Node 20, esbuild) | Knowledge base sync pipeline | Medium | SQS event source, batchSize=1; bundles `pdf-parse` + `@aws-sdk/client-s3vectors` |
| S3 event notification → SQS (normalized/ prefix) | Triggers vector processing on discovery output | Low | S3 bucket notification to SQS with prefix filter |
| S3 Vector Bucket + 2 vector indexes | Inventory + KB semantic search | High | `cdk-s3-vectors` has no Pulumi equivalent — needs `aws.cloudformation.Stack` or raw CFN resource |
| S3 Tables (Iceberg) TableBucket + Namespace + Table | Discovery stores normalized inventory in Iceberg | High | `@aws-cdk/aws-s3tables-alpha` has no Pulumi equivalent — needs raw CFN or `aws.cloudformation.Stack` |
| Cognito UserPool + UserPoolDomain + UserPoolClient + IdentityPool | Auth for web UI | Medium | UserPoolClient has `generateSecret: true` — client secret must be passed to ECS env |
| IAM roles (Lambda, ECS task, ECS execution, Discovery, Scheduler, Cognito authenticated) | Least-privilege access for all compute | High | 6 distinct roles; cross-account STS AssumeRole patterns must be preserved |
| ECS Fargate cluster + WebUI task definition (ARM64) | Runs the Next.js web UI | Medium | Container image built from `web-ui/Dockerfile.ecs`; needs ECR push step |
| ECS Fargate service (desiredCount from config, circuit breaker) | Keeps web UI running | Low | minHealthyPercent=100, maxHealthyPercent=200 |
| ALB + target group + HTTP listener | Routes traffic to ECS service | Low | idleTimeout=1200s for streaming; health check on `/api/health` |
| Auto scaling (CPU 70% + Memory 75%) | Handles load spikes | Low | min/max from config |
| Discovery ECS task definition (ARM64, Python image) | Multi-account resource discovery | Medium | Python container from `lambda/discovery/`; ARM64 platform |
| EventBridge Scheduler (daily discovery at 2AM UTC) | Scheduled discovery runs | Low | `aws.scheduler.Schedule` resource; needs scheduler IAM role |
| EventBridge Rule (StartDiscovery event pattern) | On-demand discovery trigger from web UI | Low | source: `nucleus.app`, detailType: `StartDiscovery` |
| EventBridge Rule (scheduler cron, every 30 min) | Triggers scheduler Lambda | Low | cron expression from config |
| CloudFront distribution (ALB origin, caching disabled) | CDN + HTTPS termination | Medium | originVerifySecret must be a stable Pulumi random resource, not `crypto.randomBytes` |
| 30+ ECS container env vars wired from stack outputs | Web UI reads all resource names/IDs from env | High | Every table name, bucket name, Cognito ID, Lambda ARN must flow through as Pulumi Output<string> |
| CDK removal for NetworkingStack + ComputeStack | bin/cdkStack.ts, lib/networkingStack.ts, lib/computeStack.ts deleted | Low | WebUIStack stays; CDK deps stay in package.json for WebUIStack |

---

## Differentiators

Features that make this a good migration, not just a working one.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Typed stack outputs via `StackReference` | Compile-time safety on cross-stack references vs CDK's stringly-typed CfnOutput | Low | Export outputs as typed object from networking stack |
| Stable resource names (no CDK logical ID hashing) | CDK appends 8-char hashes to logical IDs; Pulumi uses explicit names | Low | Explicitly set `name:` on every resource — avoids replacement on rename |
| `pulumi preview` before every deploy | Shows exact diff including replacements — safer than `cdk diff` | Low | Enforce in runbook: always preview before up |
| Pulumi config secrets for sensitive values | `pulumi config set --secret` encrypts at rest in state; CDK puts secrets in plaintext env vars | Low | Replace `NEXTAUTH_SECRET` and `COGNITO_CLIENT_SECRET` hardcoded strings |
| `pulumi.random.RandomString` for originVerifySecret | CDK uses `crypto.randomBytes` which changes every synth; Pulumi random is stable across deploys | Low | Prevents CloudFront origin header from rotating on every deploy |
| Explicit `retainOnDelete` on stateful resources | DynamoDB tables, S3 buckets — protect against accidental `pulumi destroy` | Low | Set `retainOnDelete: true` on all DynamoDB tables and S3 buckets |
| Per-stack TypeScript config interface | Typed config object replaces CDK's `getConfig()` + env var parsing | Low | `new pulumi.Config()` with typed getters |

---

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Use `@pulumi/cdk` (CDK adapter) | Defeats the purpose; still runs CloudFormation under the hood | Full rewrite using `@pulumi/aws` primitives |
| Import existing live AWS resources | Risky; state drift causes replacement surprises; this is a fresh deploy | Deploy fresh, cut over DNS/env vars, decommission CDK stacks |
| Pulumi Cloud backend | Adds external dependency and cost; S3 backend is sufficient | S3 backend with DynamoDB locking |
| Migrate WebUIStack to Pulumi | Out of scope per PROJECT.md; adds risk with no benefit | Keep WebUIStack in CDK as-is |
| Add new AWS resources not in CDK | Scope creep; parity is the goal | Exact resource parity only |
| Timestamp+random suffix in IAM role names | CDK anti-pattern that causes role replacement on every deploy | Use stable, deterministic role names |
| Monolithic single Pulumi program | Hard to reason about; networking and compute have different change cadences | Two separate Pulumi stacks (networking + compute) |
| Python Lambda rewrite | Discovery Lambda stays Python per PROJECT.md constraints | Keep Python container, just reference it from Pulumi |

---

## Feature Dependencies

```
PULUMI-01: Scaffold (S3 backend, DynamoDB lock, tsconfig, pulumi.yaml)
  └── PULUMI-02: NetworkingStack (VPC, subnets, NAT, endpoints, subnet groups, outputs)
        └── PULUMI-03: ComputeStack — ECS (cluster, task defs, ALB, CloudFront, auto scaling)
              ├── PULUMI-04: ComputeStack — Lambda (scheduler, vector processor, kb sync, discovery task)
              │     └── depends on: DynamoDB tables, S3 buckets, SQS queues (PULUMI-05)
              └── PULUMI-05: ComputeStack — Data (DynamoDB, SQS, EventBridge, Cognito, S3, S3 Vectors, S3 Tables)
                    └── PULUMI-06: Stack outputs → web-ui env vars; CDK removal
```

Key ordering constraints:
- DynamoDB tables must exist before ECS task env vars can reference their names
- Cognito UserPool + UserPoolClient must exist before ECS env vars (COGNITO_USER_POOL_ID, client secret)
- S3 Vector Bucket must exist before vector indexes can be created
- VPC must exist before ECS cluster, ALB, security groups, discovery task

---

## MVP Recommendation

Prioritize in this order:

1. Scaffold + S3 backend (PULUMI-01) — unblocks everything
2. NetworkingStack (PULUMI-02) — unblocks ComputeStack
3. Data layer: DynamoDB + S3 + SQS + Cognito (PULUMI-05) — unblocks ECS env vars
4. Lambda functions (PULUMI-04) — depends on data layer
5. ECS + ALB + CloudFront (PULUMI-03) — depends on all of the above
6. Stack outputs + CDK removal (PULUMI-06) — final cutover

Defer: S3 Vectors and S3 Tables (Iceberg) — no native Pulumi provider support; use raw CloudFormation resources via `aws.cloudformation.Stack` as a last step. These are non-blocking for the web UI to function.

---

## Special Complexity Notes

### S3 Vectors (`cdk-s3-vectors`)
CDK uses an alpha construct (`cdk-s3-vectors`) that wraps a new AWS service. Pulumi's `@pulumi/aws` provider may not have native support yet. Options:
1. `aws.cloudformation.Stack` wrapping the CFN template — HIGH confidence this works
2. Wait for `@pulumi/aws` provider update — LOW confidence on timeline

### S3 Tables / Apache Iceberg (`@aws-cdk/aws-s3tables-alpha`)
Same situation as S3 Vectors — alpha CDK construct. Use `aws.cloudformation.Stack` as a wrapper.

### Container Image Builds
CDK's `ecs.ContainerImage.fromAsset` builds Docker images during `cdk deploy`. Pulumi equivalent is `docker.Image` from `@pulumi/docker` or `awsx.ecr.Image` from `@pulumi/awsx`. Requires Docker daemon available during `pulumi up`.

### Cognito Client Secret
CDK uses `.userPoolClientSecret?.unsafeUnwrap()` to pass the secret as a plaintext env var. In Pulumi, use `aws.cognito.UserPoolClient` and reference `.clientSecret` as a Pulumi secret output — never log it.

### EventBridge Scheduler
CDK uses `new cdk.CfnResource(... type: 'AWS::Scheduler::Schedule')` (raw CFN). Pulumi has `aws.scheduler.Schedule` as a native resource — cleaner than CDK's approach.

---

## Sources

- Direct analysis of `lib/networkingStack.ts` (177 lines) — HIGH confidence
- Direct analysis of `lib/computeStack.ts` (1385 lines) — HIGH confidence
- `.planning/PROJECT.md` for scope constraints — HIGH confidence
- Pulumi AWS provider docs (aws.scheduler.Schedule, aws.cognito.*) — MEDIUM confidence (training data, verify against current provider)

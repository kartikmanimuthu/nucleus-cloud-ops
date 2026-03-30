# Requirements: Pulumi IaC Migration

**Milestone:** v2.0
**Defined:** 2026-03-29
**Core Value:** Pulumi TypeScript managing all core AWS infrastructure — CDK removed for NetworkingStack + ComputeStack, WebUIStack stays in CDK

---

## Milestone v2.0 Requirements

### Foundation

- [x] **PULUMI-01**: Engineer can scaffold the Pulumi project in `infra/` with S3 backend, KMS secrets provider, and two Pulumi projects (`infra/networking/`, `infra/compute/`) — `pulumi preview` runs without error
- [x] **PULUMI-02**: Engineer can deploy NetworkingStack via Pulumi: VPC, 4-tier subnets (Public/Private/Database/Intra), NAT gateway, IGW, VPC Gateway Endpoints (S3 + DynamoDB), RDS/ElastiCache subnet groups
- [x] **PULUMI-03**: ComputeStack reads VPC ID and subnet IDs from NetworkingStack via `StackReference.requireOutput()` — no hardcoded IDs

### Data Layer

- [x] **PULUMI-04**: Engineer can deploy all 9 DynamoDB tables via Pulumi with correct schemas, GSIs, TTL attributes, and `retainOnDelete: true` protection matching the CDK definitions
- [x] **PULUMI-05**: Engineer can deploy all 4 S3 buckets via Pulumi with correct lifecycle rules (checkpoint 30d, agent-temp 1d, inventory raw 365d/exports 7d, kb-staging 1d)
- [x] **PULUMI-06**: Engineer can deploy VectorProcessing and KBSync SQS queue pairs with DLQs and a CloudWatch alarm on VectorProcessingDLQ (threshold=1)
- [x] **PULUMI-07**: Engineer can deploy Cognito UserPool, UserPoolDomain, UserPoolClient (with generated secret), and IdentityPool via Pulumi — client secret stored as Pulumi secret output

### Compute — Lambda

- [x] **PULUMI-08**: Engineer can deploy Scheduler Lambda (ARM64, Node 20) via Pulumi with esbuild pre-build step, correct IAM role, EventBridge trigger (every 30 min), and all env vars wired from stack outputs
- [x] **PULUMI-09**: Engineer can deploy VectorProcessor Lambda (ARM64, Node 20) via Pulumi with SQS event source (batchSize=1, maxConcurrency=5) and esbuild pre-build
- [x] **PULUMI-10**: Engineer can deploy KBSyncProcessor Lambda (ARM64, Node 20) via Pulumi with SQS event source (batchSize=1) and esbuild pre-build
- [x] **PULUMI-11**: Engineer can deploy Discovery ECS task definition (ARM64, Python container) via Pulumi with EventBridge Scheduler (daily 2AM UTC) and EventBridge Rule for on-demand `StartDiscovery` events

### Compute — ECS + ALB + CloudFront

- [x] **PULUMI-12**: Engineer can deploy ECS Fargate cluster and WebUI task definition (ARM64) via Pulumi with all 30+ container env vars wired from stack outputs via `pulumi.all()`
- [x] **PULUMI-13**: Engineer can deploy ECS Fargate service via Pulumi with `forceNewDeployment: true`, deployment circuit breaker (enable + rollback), ALB target group, and auto scaling (CPU 70% + Memory 75%)
- [x] **PULUMI-14**: Engineer can deploy ALB with HTTP listener (idleTimeout=1200s) and health check on `/api/health` via Pulumi
- [ ] **PULUMI-15**: Engineer can deploy CloudFront distribution via Pulumi with ALB origin, caching disabled, and a stable `random.RandomString` origin verify secret (not `crypto.randomBytes`)

### Cutover + Cleanup

- [ ] **PULUMI-16**: Engineer can run `scripts/generate-env.ts` to read `pulumi stack output --json` and write `web-ui/.env.local` with all required env vars
- [ ] **PULUMI-17**: Engineer can destroy CDK NetworkingStack and ComputeStack after Pulumi stacks are smoke-tested — `lib/networkingStack.ts`, `lib/computeStack.ts`, and `bin/cdkStack.ts` deleted; CDK deps removed for those stacks (WebUIStack and its CDK deps remain)
- [ ] **PULUMI-18**: S3 Vectors (2 indexes) and S3 Tables (Iceberg TableBucket) are wrapped in `aws.cloudformation.Stack` resources in the Pulumi compute stack — CFN templates extracted from `cdk synth` output

---

## Future Requirements

- RDS/Aurora CDK stack for production PostgreSQL (from v1.0 active requirements)
- RDS Proxy for Lambda connection pooling
- Migrate WebUIStack from CDK to Pulumi (deferred — out of scope for v2.0)
- CloudWatch alarms for PostgreSQL connection pool saturation
- Full cutover: flip all USE_PG_* flags to true in production

---

## Out of Scope

- WebUIStack migration to Pulumi — stays in CDK; no benefit, adds risk
- Importing existing live CDK-managed AWS resources into Pulumi state — blue/green fresh deploy instead
- `@pulumi/cdk` adapter — defeats the migration purpose
- `@pulumi/awsx` higher-level abstractions — use `@pulumi/aws` primitives for CDK parity
- Pulumi Cloud backend — S3 backend is sufficient
- Discovery Lambda rewrite from Python to TypeScript — stays Python per project constraints
- Performance benchmarking CDK vs Pulumi deploy times

---

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| PULUMI-01 | Phase 6 | Complete |
| PULUMI-02 | Phase 7 | Complete |
| PULUMI-03 | Phase 7 | Complete |
| PULUMI-04 | Phase 8 | Complete |
| PULUMI-05 | Phase 8 | Complete |
| PULUMI-06 | Phase 8 | Complete |
| PULUMI-07 | Phase 8 | Complete |
| PULUMI-08 | Phase 9 | Complete |
| PULUMI-09 | Phase 9 | Complete |
| PULUMI-10 | Phase 9 | Complete |
| PULUMI-11 | Phase 9 + Phase 10 | Complete |
| PULUMI-12 | Phase 10 | Complete |
| PULUMI-13 | Phase 10 | Complete |
| PULUMI-14 | Phase 10 | Complete |
| PULUMI-15 | Phase 10 | Pending |
| PULUMI-16 | Phase 11 | Pending |
| PULUMI-17 | Phase 11 | Pending |
| PULUMI-18 | Phase 11 | Pending |

---

*Last updated: 2026-03-29 — v2.0 roadmap created; all 18 requirements mapped to phases 6–11*

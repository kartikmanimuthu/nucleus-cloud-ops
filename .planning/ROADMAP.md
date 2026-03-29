# Roadmap: Pulumi IaC Migration

## Overview

Six phases migrate the core AWS infrastructure from CDK to Pulumi TypeScript. Each phase delivers a deployable, verifiable slice — toolchain first, then networking, then stateful data resources, then compute (Lambda before ECS because Lambda ARNs feed ECS env vars), then cutover and CDK removal. WebUIStack stays in CDK throughout. The blue/green approach means CDK-managed resources stay live until Pulumi stacks are smoke-tested.

## Phases

**Phase Numbering:**
- Phases 1–5 belong to v1.0 (DynamoDB → PostgreSQL migration, archived in `.planning/milestones/v1.0-ROADMAP.md`)
- v2.0 continues from Phase 6

- [ ] **Phase 6: Scaffold** - Pulumi toolchain installed, S3 backend configured, KMS secrets provider set up, both projects preview without error
- [ ] **Phase 7: Networking** - VPC, 4-tier subnets, NAT gateway, VPC endpoints deployed via Pulumi with stable stack outputs
- [ ] **Phase 8: Data Layer** - All DynamoDB tables, S3 buckets, SQS queues, and Cognito resources deployed with retention protection
- [ ] **Phase 9: Lambda + EventBridge** - Scheduler, VectorProcessor, KBSyncProcessor Lambdas and Discovery ECS task deployed with correct triggers
- [ ] **Phase 10: ECS + ALB + CloudFront** - Web UI running on ECS Fargate behind ALB and CloudFront with all env vars wired from stack outputs
- [ ] **Phase 11: Cutover + CDK Removal** - Stack outputs wired to web-ui env, CDK NetworkingStack + ComputeStack destroyed and source deleted

## Phase Details

### Phase 6: Scaffold
**Goal**: The Pulumi toolchain is installed and both projects can be previewed without error — no AWS resources deployed yet
**Depends on**: Nothing (first phase of v2.0)
**Requirements**: PULUMI-01
**Success Criteria** (what must be TRUE):
  1. `pulumi preview` runs without error in both `infra/networking/` and `infra/compute/` against the S3 backend
  2. KMS secrets provider is configured — no passphrase required to unlock state
  3. `infra/` directory structure exists with two Pulumi projects, each with their own `package.json`, `tsconfig.json`, and `Pulumi.yaml`
**Plans**: 2 plans
Plans:
- [ ] 06-01-PLAN.md — Bootstrap script + networking and compute project scaffolds (11 files)
- [ ] 06-02-PLAN.md — npm install, stack init, pulumi preview verification in both projects

### Phase 7: Networking
**Goal**: A new VPC with 4-tier subnets, NAT gateway, and VPC endpoints is deployed via Pulumi and exports stable outputs for compute to consume
**Depends on**: Phase 6
**Requirements**: PULUMI-02, PULUMI-03
**Success Criteria** (what must be TRUE):
  1. `pulumi up` in `infra/networking/` creates VPC, subnets, NAT gateway, IGW, and VPC Gateway Endpoints without error
  2. Stack outputs (vpcId, subnetIds) are readable via `pulumi stack output` and match the deployed resource IDs
  3. `infra/compute/` reads networking outputs via `StackReference.requireOutput()` without returning undefined — verified by a preview that references the outputs
**Plans**: TBD

### Phase 8: Data Layer
**Goal**: All stateful AWS resources (DynamoDB, S3, SQS, Cognito) are deployed via Pulumi with retention protection and correct configurations
**Depends on**: Phase 7
**Requirements**: PULUMI-04, PULUMI-05, PULUMI-06, PULUMI-07
**Success Criteria** (what must be TRUE):
  1. All 9 DynamoDB tables deploy with correct GSIs, TTL attributes, and `retainOnDelete: true` — `pulumi preview` shows no replacements after initial deploy
  2. All 4 S3 buckets deploy with correct lifecycle rules; both SQS queue pairs deploy with DLQs; CloudWatch alarm on VectorProcessingDLQ is active (threshold=1)
  3. Cognito UserPool, UserPoolClient, and IdentityPool deploy successfully — client secret is stored as a Pulumi secret output, not plaintext in stack outputs
**Plans**: TBD

### Phase 9: Lambda + EventBridge
**Goal**: All Lambda functions and the Discovery ECS task are deployed via Pulumi with correct triggers, IAM roles, and env vars wired from data layer outputs
**Depends on**: Phase 8
**Requirements**: PULUMI-08, PULUMI-09, PULUMI-10, PULUMI-11
**Success Criteria** (what must be TRUE):
  1. Scheduler Lambda deploys (ARM64, Node 20, esbuild pre-build) and EventBridge triggers it every 30 minutes — CloudWatch logs confirm invocations
  2. VectorProcessor and KBSyncProcessor Lambdas deploy with SQS event sources; sending a test message to each queue triggers the respective Lambda
  3. Discovery ECS task definition deploys with EventBridge Scheduler (daily 2AM UTC) and an on-demand `StartDiscovery` event rule
**Plans**: TBD

### Phase 10: ECS + ALB + CloudFront
**Goal**: The web UI container is running on ECS Fargate behind ALB and CloudFront with all env vars wired from stack outputs
**Depends on**: Phase 9
**Requirements**: PULUMI-12, PULUMI-13, PULUMI-14, PULUMI-15
**Success Criteria** (what must be TRUE):
  1. ECS Fargate service deploys with circuit breaker enabled and `forceNewDeployment: true`; `pulumi up` waits for steady state before completing
  2. ALB health check on `/api/health` returns 200; the web UI is reachable via the ALB DNS name
  3. CloudFront distribution deploys with a stable `random.RandomString` origin verify secret; the web UI is reachable via the CloudFront URL
  4. All 30+ container env vars are populated from stack outputs via `pulumi.all()` — no hardcoded resource IDs in the task definition
**Plans**: TBD

### Phase 11: Cutover + CDK Removal
**Goal**: Pulumi is the sole IaC for NetworkingStack and ComputeStack — CDK stacks are destroyed, source files deleted, and S3 Vectors/Tables wrapped in CloudFormation
**Depends on**: Phase 10
**Requirements**: PULUMI-16, PULUMI-17, PULUMI-18
**Success Criteria** (what must be TRUE):
  1. `scripts/generate-env.ts` reads `pulumi stack output --json` and writes a valid `web-ui/.env.local` — the app starts locally with the generated env file
  2. CDK NetworkingStack and ComputeStack are destroyed without error; `lib/networkingStack.ts`, `lib/computeStack.ts`, and `bin/cdkStack.ts` are deleted from the repo
  3. S3 Vectors (2 indexes) and S3 Tables (Iceberg TableBucket) are wrapped in `aws.cloudformation.Stack` in the Pulumi compute stack and deploy successfully
  4. WebUIStack CDK deploy still works after cleanup — only NetworkingStack + ComputeStack CDK deps are removed
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in strict numeric order: 6 → 7 → 8 → 9 → 10 → 11
Data before ECS is the critical constraint — 30+ ECS env vars are Output<string> references to resources that must exist before the task definition can be written.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 6. Scaffold | 0/2 | Planning complete | - |
| 7. Networking | 0/? | Not started | - |
| 8. Data Layer | 0/? | Not started | - |
| 9. Lambda + EventBridge | 0/? | Not started | - |
| 10. ECS + ALB + CloudFront | 0/? | Not started | - |
| 11. Cutover + CDK Removal | 0/? | Not started | - |

# Project Research Summary

**Project:** Nucleus Cloud Ops — CDK → Pulumi TypeScript IaC Migration
**Domain:** AWS IaC migration (CDK v2 → Pulumi TypeScript)
**Researched:** 2026-03-29
**Confidence:** HIGH (stack + architecture verified against official Pulumi docs; features from direct CDK source analysis)

---

## Executive Summary

This is a full rewrite of two CDK stacks (NetworkingStack + ComputeStack) into Pulumi TypeScript, with WebUIStack staying in CDK. The migration is a blue/green replacement — Pulumi creates new AWS resources in parallel with the existing CDK-managed infrastructure, then a single cutover switches traffic. There is no in-place import of live CDK resources. The stack is minimal: `@pulumi/pulumi ^3.228.0` and `@pulumi/aws ^7.23.0` in an isolated `infra/` subdirectory, backed by an S3 bucket (no DynamoDB lock table needed — Pulumi uses S3 conditional writes for locking, unlike Terraform).

The recommended approach is two separate Pulumi projects (`infra/networking/` and `infra/compute/`) mirroring the two CDK stacks, connected via `StackReference`. The data layer (DynamoDB, Cognito, SQS, S3) must be built before ECS because 30+ container env vars reference resource names/IDs that only exist as `Output<string>` values at deploy time. Two resources have no native Pulumi provider support — S3 Vectors and S3 Tables (Iceberg) — and must be wrapped in `aws.cloudformation.Stack`; these are non-blocking for the web UI and should be deferred to the final phase.

The primary risks are auto-naming causing unintended resource recreation, passphrase loss locking the S3 backend state, and the ECS service silently running stale task definitions after updates. All three have clear mitigations: explicit `name` properties on every resource, KMS as the secrets provider instead of a passphrase, and `forceNewDeployment: true` on the ECS service.

---

## Key Findings

### Recommended Stack

Two npm packages cover the entire migration. `@pulumi/pulumi ^3.228.0` provides the core SDK (stack, config, outputs, resource model) and `@pulumi/aws ^7.23.0` provides the AWS Classic provider with 1:1 coverage of every resource in the existing CDK stacks. No higher-level abstractions (`@pulumi/awsx`, `@pulumi/cdk`) are needed or recommended — they add indirection that makes CDK parity harder to verify.

The Pulumi project lives in `infra/` (not at the repo root) because CDK's `tsconfig.json` uses `"module": "commonjs"` while Pulumi TypeScript uses `"module": "ESNext"` — they conflict if co-located. Each Pulumi project (`infra/networking/`, `infra/compute/`) gets its own `package.json`, `tsconfig.json`, and `Pulumi.yaml`.

**Core technologies:**
- `@pulumi/pulumi ^3.228.0` — core SDK, stack outputs, StackReference, config — only option
- `@pulumi/aws ^7.23.0` — AWS Classic provider, broadest coverage, stable API — preferred over `aws-native`
- S3 backend (`nucleus-pulumi-state` bucket, versioning enabled) — no DynamoDB needed; Pulumi uses S3 conditional writes for locking
- KMS secrets provider (`awskms://alias/pulumi-secrets`) — replaces passphrase-based encryption; required for team/CI use

**What NOT to add:**
- `@pulumi/awsx` — higher-level abstractions obscure CDK parity
- `@pulumi/cdk` — defeats the migration purpose
- Pulumi Cloud backend — adds SaaS dependency; S3 backend is sufficient
- DynamoDB lock table — this is a Terraform pattern, not Pulumi

### Expected Features

The migration scope is exact resource parity with the two CDK stacks. Direct analysis of `lib/networkingStack.ts` (177 lines) and `lib/computeStack.ts` (1385 lines) produced a complete feature inventory.

**Must have (table stakes):**
- Pulumi project scaffold with S3 backend and KMS secrets provider
- NetworkingStack parity: VPC, 4-tier subnets (Public/Private/Database/Intra), NAT gateway, IGW, VPC Gateway Endpoints (S3 + DynamoDB), RDS/ElastiCache subnet groups, stack outputs
- 9 DynamoDB tables with correct schemas, GSIs, and TTL attributes (AppTable/AuditTable/InventoryTable each have 3 GSIs)
- 4 S3 buckets with lifecycle rules, 2 SQS queue pairs (queue + DLQ), CloudWatch alarm on VectorProcessingDLQ
- Cognito UserPool + UserPoolDomain + UserPoolClient + IdentityPool (client secret passed as Pulumi secret output)
- 6 IAM roles with least-privilege policies and cross-account STS AssumeRole patterns preserved
- ECS Fargate cluster + WebUI task definition (ARM64) + service with circuit breaker + ALB + auto scaling
- 3 Lambda functions (Scheduler, VectorProcessor, KBSyncProcessor) with esbuild pre-build step
- Discovery ECS task definition (ARM64, Python container) + EventBridge Scheduler (daily 2AM UTC)
- CloudFront distribution with stable `pulumi.random.RandomString` origin verify secret
- 30+ ECS container env vars wired from stack outputs via `pulumi.all()`
- StackReference from compute → networking for VPC ID and subnet IDs
- CDK removal of `lib/networkingStack.ts`, `lib/computeStack.ts`, `bin/cdkStack.ts` (Phase 6 only)

**Should have (differentiators over CDK):**
- Stable explicit resource names (no CDK logical ID hashing) — prevents replacement on refactor
- `retainOnDelete: true` on all DynamoDB tables and S3 buckets — protection against accidental `pulumi destroy`
- `pulumi config set --secret` for NEXTAUTH_SECRET and Cognito client secret — encrypted at rest
- `forceNewDeployment: true` on ECS service — ensures task definition updates actually redeploy
- `deploymentCircuitBreaker: { enable: true, rollback: true }` — auto-rollback on failed ECS deployments
- `scripts/generate-env.ts` — reads `pulumi stack output --json` and writes `web-ui/.env.local`
- ComponentResource pattern for logical grouping in `infra/compute/components/`

**Defer (post-cutover):**
- S3 Vectors (2 indexes) — no native `@pulumi/aws` support; wrap in `aws.cloudformation.Stack`
- S3 Tables / Apache Iceberg TableBucket — same situation; wrap in `aws.cloudformation.Stack`
- Both are non-blocking for the web UI to function

### Architecture Approach

Two separate Pulumi projects in `infra/networking/` and `infra/compute/` mirror the two CDK stacks. They are connected via `StackReference` — compute reads networking outputs (VPC ID, subnet IDs) as typed `Output<string>` values. The large ComputeStack is split into ComponentResources (`dynamodb.ts`, `ecs.ts`, `lambda.ts`, `cognito.ts`, `cloudfront.ts`, `storage.ts`) to keep `index.ts` manageable. The cutover is blue/green: Pulumi deploys new resources alongside CDK-managed ones, then DNS/CloudFront is switched and CDK stacks are destroyed.

**Major components:**
1. `infra/bootstrap/bootstrap.sh` — one-time S3 state bucket creation (manual, prerequisite)
2. `infra/networking/` — VPC, subnets, NAT, endpoints, subnet groups; exports vpcId + subnetIds
3. `infra/compute/` — all application resources; reads networking via StackReference
4. `scripts/generate-env.ts` — bridges Pulumi stack outputs to web-ui env vars
5. `lib/webUIStack.ts` — stays in CDK, untouched throughout migration

### Critical Pitfalls

1. **Auto-naming causes resource recreation** — Pulumi appends a random 7-char suffix by default; any code rename triggers delete+create. Set explicit physical name properties on every resource. Run `pulumi preview` and treat any `[replace]` as a blocker before `pulumi up`.

2. **Passphrase loss locks S3 backend state permanently** — Use KMS secrets provider (`--secrets-provider="awskms://alias/pulumi-secrets"`) instead of a passphrase. Never rely on `PULUMI_CONFIG_PASSPHRASE` for team/CI environments.

3. **ECS service silently runs stale task definition** — Pulumi updates the task definition revision but ECS doesn't redeploy unless forced. Set `forceNewDeployment: true` and `waitForSteadyState: true` on `aws.ecs.Service`.

4. **Lambda bundling — no NodejsFunction equivalent** — Pulumi has no CDK L2 construct for TypeScript Lambda bundling. Pre-build with esbuild to `dist/index.js`, then reference via `pulumi.asset.FileArchive("./dist")`. Mark `@aws-sdk/*` as external.

5. **StackReference returns `undefined` silently** — Wrong stack reference name format (`<project>/<stack>` for S3 backend, no org prefix) causes `requireOutput()` to return `undefined`, which propagates silently into resource configs. Use `requireOutput()` (throws on missing) not `getOutput()` (returns undefined).

---

## Implications for Roadmap

### Phase 1: Scaffold
**Rationale:** Unblocks everything. No AWS resources deployed — pure toolchain validation.
**Delivers:** `infra/` directory structure, both `Pulumi.yaml` files, `package.json`/`tsconfig.json` for each project, S3 state bucket created via `bootstrap.sh`, KMS key for secrets, `pulumi login` verified, `pulumi preview` runs without error.
**Addresses:** PULUMI-01 from feature dependency graph.
**Avoids:** Passphrase loss (Pitfall 4) — KMS provider set up from day one; CDK bootstrap conflicts (Pitfall 2) — distinct `infra/` naming from CDK's `lib/`.

### Phase 2: Networking
**Rationale:** All compute resources depend on VPC and subnet IDs. Must deploy first and export stable outputs.
**Delivers:** New VPC alongside existing CDK VPC, 4-tier subnets, NAT gateway, VPC Gateway Endpoints, RDS/ElastiCache subnet groups, StackReference outputs verified.
**Uses:** `aws.ec2.Vpc`, `aws.ec2.Subnet`, `aws.ec2.NatGateway`, `aws.ec2.VpcEndpoint`.
**Avoids:** Auto-naming (Pitfall 1) — explicit `tags.Name` on VPC and all subnets; output name stability (Pitfall 12) — output names locked as public API from first deploy.

### Phase 3: Data Layer
**Rationale:** ECS container env vars reference DynamoDB table names, Cognito IDs, and S3 bucket names as `Output<string>`. Data layer must exist before ECS task definition can be written. This is the critical ordering constraint — data before compute.
**Delivers:** 9 DynamoDB tables with GSIs + TTL, 4 S3 buckets with lifecycle rules, 2 SQS queue pairs + DLQ alarms, Cognito UserPool + client + identity pool, SNS topic, all IAM roles.
**Implements:** `infra/compute/components/dynamodb.ts`, `cognito.ts`, `storage.ts`.
**Avoids:** DynamoDB table recreation (Pitfall 3) — `retainOnDelete: true` set immediately; Cognito client secret exposure — stored as Pulumi secret output, never logged.

### Phase 4: Lambda Functions
**Rationale:** Lambda functions depend on DynamoDB tables (event sources, env vars) and S3 buckets. Data layer must be complete first. Lambda ARNs are also referenced in ECS env vars.
**Delivers:** Scheduler Lambda (ARM64, Node 20, esbuild pre-build), VectorProcessor Lambda (SQS event source), KBSyncProcessor Lambda, Discovery ECS task definition, EventBridge rules and Scheduler.
**Implements:** `infra/compute/components/lambda.ts`.
**Avoids:** Lambda bundling failure (Pitfall 7) — esbuild pre-build step before `pulumi up`; missing log groups (Pitfall 15) — explicit `aws.cloudwatch.LogGroup` for each Lambda.

### Phase 5: ECS + ALB + CloudFront
**Rationale:** Depends on all prior phases — needs VPC (Phase 2), table names (Phase 3), and Lambda ARNs (Phase 4) to wire the 30+ container env vars via `pulumi.all()`.
**Delivers:** ECS Fargate cluster, WebUI task definition with full env var block, ALB + target group + HTTP listener, auto scaling, CloudFront distribution with stable origin verify secret.
**Implements:** `infra/compute/components/ecs.ts`, `cloudfront.ts`.
**Avoids:** ECS stale deployment (Pitfall 8) — `forceNewDeployment: true`; CloudFront OAC missing (Pitfall 14) — manual OAC + bucket policy; CloudFront timeout (Pitfall 9) — CI/CD timeout set ≥45 min.

### Phase 6: Cutover + CDK Removal
**Rationale:** Final phase only after Pulumi stack is fully deployed and smoke-tested. Blue/green switch — CDK stays live until Pulumi is verified healthy.
**Delivers:** `scripts/generate-env.ts` wiring stack outputs to `web-ui/.env.local`, CDK NetworkingStack + ComputeStack destroyed, `lib/networkingStack.ts` + `lib/computeStack.ts` + `bin/cdkStack.ts` deleted, CDK deps removed from root `package.json`. S3 Vectors + S3 Tables wrapped in `aws.cloudformation.Stack`.
**Avoids:** Destroy order (Pitfall 13) — destroy CDK compute before CDK networking; CDK bootstrap left intact — `CDKToolkit` stack stays for WebUIStack.

### Phase Ordering Rationale

- Data before ECS is the critical constraint — 30+ ECS env vars are `Output<string>` references to resources that must exist before the task definition can be written
- Networking before everything — VPC ID and subnet IDs are required by ECS, ALB, Lambda VPC config, and security groups
- Lambda before ECS — Lambda ARNs are referenced in ECS container env vars
- Cutover last and only after full smoke test — blue/green means CDK stays live until Pulumi is verified

### Research Flags

Phases needing deeper research during planning:
- **Phase 5 (CloudFront):** CloudFront OAC wiring in `@pulumi/aws` — verify `aws.cloudfront.OriginAccessControl` + bucket policy pattern against current provider docs before implementation
- **Phase 6 (S3 Vectors + S3 Tables):** No native Pulumi provider support confirmed; `aws.cloudformation.Stack` wrapper approach needs a working CFN template extracted from `cdk synth` output

Phases with standard patterns (skip research-phase):
- **Phase 1 (Scaffold):** Official Pulumi docs cover this completely — HIGH confidence
- **Phase 2 (Networking):** `aws.ec2.*` resources are well-documented — no surprises expected
- **Phase 3 (Data):** DynamoDB, SQS, Cognito are standard `@pulumi/aws` resources
- **Phase 4 (Lambda):** esbuild pre-build pattern is established; verify `pulumi.asset.FileArchive` API only

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Package versions verified from npm registry; S3 backend behavior verified from official Pulumi docs |
| Features | HIGH | Derived from direct analysis of `lib/networkingStack.ts` and `lib/computeStack.ts` source files |
| Architecture | HIGH | StackReference, S3 backend, ComponentResource patterns verified from official Pulumi docs |
| Pitfalls | MEDIUM-HIGH | Core Pulumi behaviors (auto-naming, StackReference, passphrase) HIGH; ECS/CloudFront specifics MEDIUM from training data |

**Overall confidence:** HIGH

### Gaps to Address

- **Directory name:** STACK.md recommends `pulumi/` subdirectory; ARCHITECTURE.md recommends `infra/`. Use `infra/` — stronger reasoning (module system conflict, CDK coexistence clarity). Roadmapper should pick one and be consistent.

- **DynamoDB lock table contradiction:** PITFALLS.md Pitfall 5 claims Pulumi S3 backend requires a DynamoDB table with `LockID` key. STACK.md and ARCHITECTURE.md (both citing official docs) explicitly state no DynamoDB is needed. PITFALLS.md appears to have confused Pulumi's S3 backend with Terraform's. **Do not create a DynamoDB lock table.**

- **S3 Vectors + S3 Tables CFN templates:** Need to run `cdk synth` on the existing CDK stacks to extract raw CloudFormation templates for these alpha constructs before wrapping them in `aws.cloudformation.Stack`. This is a Phase 6 prerequisite — plan a task for it.

- **Container image build in Pulumi:** CDK uses `ecs.ContainerImage.fromAsset` to build Docker images during deploy. Pulumi equivalent needs verification — may require Docker daemon available during `pulumi up` or a separate ECR push step before Phase 5.

- **StackReference name format with S3 backend:** Format is `<project>/<stack>` (no org prefix). Verify this works with the specific S3 backend URL before Phase 3 depends on it.

---

## Sources

### Primary (HIGH confidence)
- `lib/networkingStack.ts` (177 lines) — direct source analysis for networking feature inventory
- `lib/computeStack.ts` (1385 lines) — direct source analysis for compute feature inventory
- Pulumi official docs (state and backends) — S3 backend URL format, no-DynamoDB confirmation
- Pulumi official docs (projects + stacks) — StackReference format, project structure
- Pulumi official docs (TypeScript SDK) — tsconfig requirements, Output<T> patterns
- npm registry — `@pulumi/pulumi` and `@pulumi/aws` version verification (2026-03-29)

### Secondary (MEDIUM confidence)
- Pulumi AWS provider registry — `aws.scheduler.Schedule`, `aws.cognito.*`, `aws.cloudfront.OriginAccessControl` resource shapes
- Training data (cutoff Aug 2025) — ECS `forceNewDeployment`, CloudFront update timing, Lambda bundling patterns

### Tertiary (LOW confidence)
- CDK/Pulumi coexistence strategy — no single authoritative source; synthesized from multiple patterns

---

*Research completed: 2026-03-29*
*Ready for roadmap: yes*

---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Completed 09-lambda-eventbridge/09-01-PLAN.md
last_updated: "2026-03-30T10:30:19.437Z"
last_activity: 2026-03-30
progress:
  total_phases: 6
  completed_phases: 3
  total_plans: 11
  completed_plans: 9
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-29)

**Core value:** Pulumi TypeScript managing all core AWS infrastructure — CDK removed for NetworkingStack + ComputeStack
**Current focus:** Phase 09 — lambda-eventbridge

## Current Position

Phase: 09 (lambda-eventbridge) — EXECUTING
Plan: 2 of 3
Status: Ready to execute
Last activity: 2026-03-30

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: none yet
- Trend: -

*Updated after each plan completion*
| Phase 06-scaffold P01 | 8 | 2 tasks | 11 files |
| Phase 06-scaffold P02 | 25 | 2 tasks | 3 files |
| Phase 07-networking P01 | 3 | 2 tasks | 4 files |
| Phase 07-networking P02 | 25 | 1 tasks | 1 files |
| Phase 07-networking P03 | 8 | 1 tasks | 0 files |
| Phase 07-networking P03 | 8 | 1 tasks | 0 files |
| Phase 08-data-layer P01 | 3 | 2 tasks | 1 files |
| Phase 08-data-layer P02 | 6 | 2 tasks | 2 files |
| Phase 08-data-layer P03 | 10 | 2 tasks | 1 files |
| Phase 09-lambda-eventbridge P09-01 | 8 | 2 tasks | 5 files |

## Accumulated Context

### Decisions

Key decisions from research (2026-03-29):

- S3 backend (no DynamoDB lock table) — Pulumi uses S3 conditional writes for locking; DynamoDB lock table is a Terraform pattern, not Pulumi
- KMS secrets provider (`awskms://alias/pulumi-secrets`) — replaces passphrase; required for CI/team use; passphrase loss locks state permanently
- Two separate Pulumi projects (`infra/networking/`, `infra/compute/`) — mirrors CDK stack split; connected via StackReference
- `infra/` subdirectory (not repo root) — CDK tsconfig uses `"module": "commonjs"`, Pulumi uses `"module": "ESNext"`; co-location causes conflicts
- `@pulumi/aws` primitives only — no `@pulumi/awsx` or `@pulumi/cdk`; CDK parity is easier to verify with 1:1 resource mapping
- Explicit physical names on every resource — Pulumi auto-naming appends 7-char suffix; any rename triggers delete+create
- `retainOnDelete: true` on all DynamoDB tables and S3 buckets — protection against accidental `pulumi destroy`
- `forceNewDeployment: true` on ECS service — ECS does not redeploy on task definition update without this
- Blue/green cutover — Pulumi deploys new resources alongside CDK; CDK stays live until Pulumi smoke-tested
- S3 Vectors + S3 Tables deferred to Phase 11 — no native `@pulumi/aws` support; wrap in `aws.cloudformation.Stack`
- [Phase 06-scaffold]: getOutput() used in compute StackReference (not requireOutput()) — networking has placeholder values during scaffold; Phase 8+ switches to requireOutput()
- [Phase 06-scaffold]: infra/ subdirectory isolation: Pulumi tsconfig commonjs module prevents conflict with root CDK tsconfig
- [Phase 06-scaffold]: KMS URI needs ?region=us-east-1 suffix — profile default region (ap-south-1) does not match bucket/key region (us-east-1)
- [Phase 06-scaffold]: StackReference for S3 backend requires literal 'organization' prefix: organization/nucleus-networking/prod
- [Phase 07-networking]: awsx.ec2.Vpc component used for networking (not raw aws.ec2.* primitives) — matches CDK ec2.Vpc abstraction level
- [Phase 07-networking]: databaseSubnetIds and intraSubnetIds filtered from vpc.subnets by Name tag — vpc.isolatedSubnetIds merges all Isolated tiers making them indistinguishable
- [Phase 07-networking]: awsx subnet naming confirmed as nucleus-vpc-<spec-name>-<index> — Name tag filter in index.ts is correct
- [Phase 07-networking]: No repo file changes on pulumi up — Pulumi state is in S3; task commit skipped (nothing to stage)
- [Phase 07-networking]: databaseSubnetIds and intraSubnetIds Name tag filters confirmed correct at deploy time — each returned exactly 2 IDs
- [Phase 07-networking]: compute requireOutput() resolves to vpc-0cd6e5fd607d1a494 — StackReference wiring is live and enforced
- [Phase 07-networking]: No repo file changes on pulumi up — Pulumi state is in S3; task commit skipped (nothing to stage)
- [Phase 07-networking]: databaseSubnetIds and intraSubnetIds Name tag filters confirmed correct at deploy time — each returned exactly 2 IDs
- [Phase 07-networking]: compute requireOutput() resolves to vpc-0cd6e5fd607d1a494 — StackReference wiring is live and enforced
- [Phase 08-data-layer]: Deprecated hashKey/rangeKey in globalSecondaryIndexes are warnings only — preview exits 0; no migration to key_schema needed for this phase
- [Phase 08-data-layer]: Used aws.getCallerIdentityOutput() instead of top-level await — tsconfig commonjs module incompatible with top-level await
- [Phase 08-data-layer]: cognitoUserPoolClientSecret exported as pulumi.secret() — encrypted in Pulumi state, shows [secret] in stack output
- [Phase 09-lambda-eventbridge]: npm ci required before esbuild for scheduler Lambda (uuid, dayjs, pg are non-AWS-SDK deps not in Lambda runtime)
- [Phase 09-lambda-eventbridge]: vector_processor esbuild runs from project root — no package.json, needs root node_modules for @aws-sdk/client-s3vectors and @prisma/client
- [Phase 09-lambda-eventbridge]: lambda.zip files added to .gitignore — build artifacts produced by infra/build-lambdas.sh, not committed to source

### Pending Todos

- Phase 6 prerequisite: create S3 state bucket via `infra/bootstrap/bootstrap.sh` (one-time manual step)
- Phase 11 prerequisite: run `cdk synth` to extract CFN templates for S3 Vectors + S3 Tables before wrapping in `aws.cloudformation.Stack`
- Phase 10 prerequisite: verify container image build approach — CDK uses `ecs.ContainerImage.fromAsset`; Pulumi equivalent needs confirmation (may require separate ECR push step)

### Blockers/Concerns

None at start of milestone.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260328-udt | Set up local dev environment and verify PostgreSQL migration works end-to-end | 2026-03-28 | bff3e55 | [260328-udt-set-up-local-dev-environment-and-verify-](./quick/260328-udt-set-up-local-dev-environment-and-verify-/) |

## Session Continuity

Last session: 2026-03-30T10:30:19.434Z
Stopped at: Completed 09-lambda-eventbridge/09-01-PLAN.md
Resume file: None

---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Pulumi IaC Migration
status: active
stopped_at: Phase 6
last_updated: "2026-03-29T00:00:00.000Z"
last_activity: 2026-03-29
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-29)

**Core value:** Pulumi TypeScript managing all core AWS infrastructure — CDK removed for NetworkingStack + ComputeStack
**Current focus:** Phase 6 — Scaffold

## Current Position

Phase: 6 — Scaffold
Plan: —
Status: Not started
Last activity: 2026-03-29 — Roadmap created for v2.0

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

Last session: 2026-03-29
Stopped at: Roadmap created — ready to begin Phase 6
Resume file: None

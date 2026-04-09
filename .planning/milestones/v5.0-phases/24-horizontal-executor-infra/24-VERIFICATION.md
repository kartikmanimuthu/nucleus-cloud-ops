---
phase: 24-horizontal-executor-infra
verified: 2026-04-09T13:40:00Z
status: passed
score: 4/4 must-haves verified
re_verification: false
---

# Phase 24: Horizontal Executor + Infra Verification Report

**Phase Goal:** HorizontalExecutor dispatches each pg-boss job to an ephemeral ECS Fargate task via RunTask, and Pulumi provisions all required infrastructure
**Verified:** 2026-04-09T13:40:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | With WORKER_ARCH=horizontal, a pg-boss job triggers an ECS RunTask call with job name and serialized data passed via container command overrides | ✓ VERIFIED | `horizontal.ts` calls `RunTaskCommand` with `launchType: "FARGATE"`, command override `["node", "dist/job-runner.js", "--job", jobName, "--data", JSON.stringify(jobData)]`; factory.ts wires `WORKER_ARCH=horizontal` → `HorizontalExecutor`; 13/13 tests pass |
| 2 | The ephemeral ECS task runs job-runner.js, completes the job, and exits — pg-boss marks the job complete when the handler returns | ✓ VERIFIED | Command override targets `dist/job-runner.js`; executor polls `DescribeTasks` until `STOPPED`, returns on exit code 0, throws on non-zero; pg-boss handler awaits `executor.execute()` so job is marked complete on return |
| 3 | Pulumi provisions the ephemeral worker task definition, security group, and CloudWatch log group without errors on `pulumi up` | ✓ VERIFIED | `ephemeralWorkerTaskDef` (family `nucleus-cloud-ops-ephemeral-worker-task`, 256/512), `ephemeralWorkersLogGroup` (`/ecs/nucleus-cloud-ops-ephemeral-workers`, 7-day retention), `workersSecurityGroup` reused via `HORIZONTAL_SECURITY_GROUP`; `npx tsc --noEmit` exits 0 |
| 4 | The IAM task role grants STS AssumeRole, RDS connect, S3 read/write, and Bedrock invoke — sufficient for all 3 job types | ✓ VERIFIED | `workers-sts-policy`: `sts:AssumeRole`; `workers-rds-connect-policy`: `rds-db:connect`; `workers-s3-policy`: `s3:GetObject/PutObject/DeleteObject/ListBucket`; `workers-bedrock-policy`: `bedrock:InvokeModel`; ephemeral task def reuses same `workersTaskRole` |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `workers/src/executor/horizontal.ts` | ECS RunTask dispatch with polling | ✓ VERIFIED | 123 lines; imports `ECSClient`, `RunTaskCommand`, `DescribeTasksCommand`; `class HorizontalExecutor implements JobExecutor`; full polling loop with exponential backoff |
| `workers/src/executor/horizontal.test.ts` | Unit tests (min 80 lines) | ✓ VERIFIED | 261 lines; 13 test cases covering dispatch, command override, polling, exit 0, exit non-zero, RunTask failures, timeout, missing env vars, backoff |
| `infra/compute/index.ts` | Ephemeral task def, log group, IAM policy, env var wiring | ✓ VERIFIED | All 6 must-have patterns present (lines 1549–1775) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `horizontal.ts` | `@aws-sdk/client-ecs` | `ECSClient, RunTaskCommand, DescribeTasksCommand` | ✓ WIRED | Line 1: `import { ECSClient, RunTaskCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs'` |
| `horizontal.ts` | `workers/src/executor/types.ts` | `implements JobExecutor` | ✓ WIRED | Line 23: `export class HorizontalExecutor implements JobExecutor` |
| `infra/compute/index.ts` (ephemeral task def) | `workersImage.imageUri` | same imageUri reference | ✓ WIRED | Line 1603: `workersImage.imageUri` in `pulumi.all([...])` for ephemeral task def |
| `infra/compute/index.ts` (workers task def env vars) | ephemeral task def ARN | `HORIZONTAL_TASK_DEF_ARN` env var | ✓ WIRED | Line 1740: `{ name: "HORIZONTAL_TASK_DEF_ARN", value: ephTaskDefArn }` |
| `infra/compute/index.ts` (ecs-dispatch-policy) | `workersTaskRole` | `RolePolicy` attachment | ✓ WIRED | Lines 1639–1669: `workers-ecs-dispatch-policy` on `workersTaskRole.id` with `ecs:RunTask` |

### Data-Flow Trace (Level 4)

Not applicable — `infra/compute/index.ts` is infrastructure provisioning code (no dynamic data rendering). `horizontal.ts` is a dispatcher, not a data-rendering component.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All 13 unit tests pass | `cd workers && npx vitest run src/executor/horizontal.test.ts` | 13/13 passed (8.5s) | ✓ PASS |
| Workers TypeScript compiles | `cd workers && npx tsc --noEmit` | exit 0 | ✓ PASS |
| Infra TypeScript compiles | `cd infra/compute && npx tsc --noEmit` | exit 0 | ✓ PASS |
| WORKER_ARCH=horizontal routes to HorizontalExecutor | `factory.ts` switch case | `case 'horizontal': return new HorizontalExecutor()` | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| EXEC-04 | 24-01-PLAN.md | HorizontalExecutor launches ECS RunTask per job, passing job name and serialized data via container overrides | ✓ SATISFIED | `horizontal.ts` full implementation; 13 tests pass |
| INFRA-01 | 24-02-PLAN.md | ECS task definition for ephemeral worker containers using same Docker image with different command | ✓ SATISFIED | `ephemeralWorkerTaskDef` at line 1584; family `nucleus-cloud-ops-ephemeral-worker-task`; same `workersImage.imageUri`; no default command |
| INFRA-02 | 24-02-PLAN.md | IAM task role with STS AssumeRole, RDS, S3, Bedrock permissions | ✓ SATISFIED | `workersTaskRole` has `workers-sts-policy`, `workers-rds-connect-policy`, `workers-s3-policy`, `workers-bedrock-policy`; ephemeral task def reuses same role |
| INFRA-03 | 24-02-PLAN.md | Pulumi provisions task definition, security group, and CloudWatch log group for ephemeral workers | ✓ SATISFIED | `ephemeralWorkerTaskDef`, `workersSecurityGroup` (reused), `ephemeralWorkersLogGroup` all provisioned; `workers-ecs-dispatch-policy` grants `ecs:RunTask + ecs:DescribeTasks + iam:PassRole` |

No orphaned requirements — all 4 phase-24 requirements (EXEC-04, INFRA-01, INFRA-02, INFRA-03) are claimed by plans and verified.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | None found | — | — |

No TODOs, stubs, placeholder returns, or empty implementations detected in `horizontal.ts` or the infra additions.

### Human Verification Required

#### 1. Live `pulumi up` execution

**Test:** Run `cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes`
**Expected:** Pulumi creates `ephemeral-workers-log-group`, `ephemeral-worker-task-def`, `workers-ecs-dispatch-policy` without errors; `ephemeralWorkerTaskDefArn` appears in stack outputs
**Why human:** TypeScript compiles clean but actual AWS API calls (IAM, ECS, CloudWatch) can fail on resource limits, naming conflicts, or permission boundaries not visible statically

#### 2. End-to-end horizontal dispatch

**Test:** Set `WORKER_ARCH=horizontal` on the workers ECS service, trigger a scheduler-scan job via pg-boss, observe CloudWatch logs under `/ecs/nucleus-cloud-ops-ephemeral-workers`
**Expected:** A new ECS task appears in the cluster, runs job-runner.js, exits 0, and pg-boss marks the job complete
**Why human:** Requires live AWS environment with running ECS cluster, pg-boss connected to RDS, and valid cross-account role

### Gaps Summary

No gaps. All 4 success criteria verified, all 4 requirements satisfied, 13/13 unit tests pass, both TypeScript projects compile clean.

One wording note: Success criterion 1 in ROADMAP.md says "container environment overrides" but the implementation correctly uses command overrides (per the plan's explicit spec). This is a ROADMAP wording imprecision, not an implementation gap — command overrides are the correct mechanism for passing `--job` and `--data` args to job-runner.js.

---

_Verified: 2026-04-09T13:40:00Z_
_Verifier: Claude (gsd-verifier)_

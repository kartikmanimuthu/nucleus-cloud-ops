# Phase 24: Horizontal Executor + Infra - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-09
**Phase:** 24-horizontal-executor-infra
**Areas discussed:** ECS RunTask dispatch, Ephemeral task definition, IAM & networking, Job completion tracking
**Mode:** Auto (--auto flag, all recommended defaults selected)

---

## ECS RunTask Dispatch

| Option | Description | Selected |
|--------|-------------|----------|
| Container command override | Pass --job and --data via RunTask overrides.containerOverrides[0].command | ✓ |
| Environment variable override | Pass job name and data as env vars in RunTask overrides | |
| S3 payload | Upload job data to S3, pass S3 key as env var | |

**User's choice:** [auto] Container command override (recommended default)
**Notes:** Leverages existing job-runner.ts CLI parsing. No additional env var plumbing needed. Job data stays ephemeral (not persisted to S3).

---

| Option | Description | Selected |
|--------|-------------|----------|
| Environment variables at startup | HORIZONTAL_CLUSTER_ARN, HORIZONTAL_TASK_DEF_ARN, etc. read from env | ✓ |
| Pulumi config file | Read config from a JSON file baked into the image | |
| AWS SSM Parameter Store | Fetch config from SSM at dispatch time | |

**User's choice:** [auto] Environment variables at startup (recommended default)
**Notes:** Consistent with how all other config is passed in this project. Pulumi outputs wire directly to task definition env vars.

---

## Ephemeral Task Definition

| Option | Description | Selected |
|--------|-------------|----------|
| Separate task def, same image | New task def with different CPU/memory, no default command | ✓ |
| Reuse workers task def | Use same task def with command override only | |
| Separate image | Build a minimal image for ephemeral tasks | |

**User's choice:** [auto] Separate task definition, same Docker image (recommended default)
**Notes:** Allows right-sizing resources (256/512 for ephemeral vs 512/1024 for long-running). Same image keeps CI/CD simple — one build pipeline.

---

## IAM & Networking

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse workersTaskRole | Same IAM role for ephemeral tasks | ✓ |
| Dedicated ephemeral role | New role with potentially narrower permissions | |

**User's choice:** [auto] Reuse workersTaskRole (recommended default)
**Notes:** Ephemeral tasks run the same job handlers — identical permission requirements. Separate role would be pure duplication.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse workersSecurityGroup | Same egress-only SG | ✓ |
| Dedicated ephemeral SG | New SG for ephemeral tasks | |

**User's choice:** [auto] Reuse workersSecurityGroup (recommended default)
**Notes:** Same network access pattern (egress to AWS APIs + RDS). No inbound traffic needed.

---

## Job Completion Tracking

| Option | Description | Selected |
|--------|-------------|----------|
| Poll DescribeTasks | Exponential backoff polling until STOPPED | ✓ |
| CloudWatch Events / EventBridge | Listen for ECS task state change events | |
| Fire and forget | RunTask and return immediately, rely on job-runner exit code | |

**User's choice:** [auto] Poll DescribeTasks (recommended default)
**Notes:** Synchronous polling keeps pg-boss job lifecycle intact — executor.execute() returns on success, throws on failure. EventBridge would require async callback infrastructure. Fire-and-forget breaks pg-boss retry semantics.

---

## Claude's Discretion

- Polling interval and backoff strategy for DescribeTasks
- Whether to add ecs:RunTask IAM policy to workersTaskRole or create separate policy
- Log formatting for dispatch/completion events

## Deferred Ideas

None — discussion stayed within phase scope

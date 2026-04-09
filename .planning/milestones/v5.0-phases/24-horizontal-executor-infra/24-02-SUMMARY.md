---
phase: 24-horizontal-executor-infra
plan: 02
status: complete
started: 2026-04-09
completed: 2026-04-09
---

## Summary

Provisioned all Pulumi infrastructure for ephemeral worker ECS tasks. Added an ephemeral worker task definition (256 CPU / 512 MiB, same Docker image, ARM64, no default command), a dedicated CloudWatch log group with 7-day retention, and an IAM policy granting ecs:RunTask (scoped to ephemeral task def), ecs:DescribeTasks (scoped to cluster), and iam:PassRole for both task and execution roles. Wired HORIZONTAL_CLUSTER_ARN, HORIZONTAL_TASK_DEF_ARN, HORIZONTAL_SUBNETS, and HORIZONTAL_SECURITY_GROUP env vars into the workers service task definition. Exported ephemeralWorkerTaskDefArn as a stack output.

## Key Files

- `infra/compute/index.ts` — Ephemeral task def, log group, IAM dispatch policy, HORIZONTAL_* env vars, stack export

## Decisions

- Moved workersSecurityGroup before workersTaskDef so SG ID can be passed as HORIZONTAL_SECURITY_GROUP env var
- privateSubnetIds pre-joined via `.apply(ids => ids.join(","))` to resolve Pulumi Output<string[]> type mismatch
- workers-logs-policy updated to cover both workers and ephemeral log groups
- Ephemeral task def reuses same workersTaskRole and ecsTaskExecutionRole (no new roles)

## Verification

- `cd infra/compute && npx tsc --noEmit` passes with no type errors
- All acceptance criteria patterns found in infra/compute/index.ts

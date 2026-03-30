---
phase: 09-lambda-eventbridge
plan: "09-03"
subsystem: infra/compute
tags: [pulumi, lambda, ecs, eventbridge, iam, discovery]
dependency_graph:
  requires: [09-01, 09-02, 08-data-layer]
  provides: [discoveryTaskDefinitionArn, discoveryTaskRoleArn, discoveryExecutionRoleArn, discoverySecurityGroupId]
  affects: [phase-10-ecs-alb]
tech_stack:
  added: []
  patterns: [pulumi-aws-ecs-task-definition, pulumi-iam-inline-policy, pulumi-eventbridge-rule]
key_files:
  created: []
  modified:
    - infra/compute/index.ts
decisions:
  - Discovery ECS task definition created without cluster ARN — Phase 10 adds EventBridge Scheduler target when cluster exists
  - discoveryImageUri config placeholder used — real ECR URI set before Discovery runs
  - EventBridge Rule created without target — Phase 10 wires aws.cloudwatch.EventTarget when ECS cluster ARN is available
metrics:
  duration_minutes: 11
  completed_date: "2026-03-30"
  tasks_completed: 2
  files_modified: 1
requirements: [PULUMI-11]
---

# Phase 09 Plan 03: Discovery ECS Task + Deploy + Verify Summary

**One-liner:** Discovery ECS task def (ARM64/FARGATE 256/512) + IAM roles + SG + EventBridge Rule deployed via Pulumi — all 8 Phase 9 stack outputs live in AWS.

## What Was Built

Task 1 appended to `infra/compute/index.ts`:
- `discoveryLogGroup` — CloudWatch log group `/ecs/nucleus-cloud-ops-discovery`, 14-day retention
- `discoveryExecutionRole` (`nucleus-cloud-ops-discovery-execution-role`) — ECS task execution role with `AmazonECSTaskExecutionRolePolicy`
- `discoveryTaskRole` (`nucleus-cloud-ops-discovery-task-role`) — 7-statement inline policy: cross-account STS, DynamoDB read on appTable, DynamoDB read/write on inventoryTable, DynamoDB write on auditTable, S3 read/write on inventoryBucket, S3Tables full access, CloudWatch Logs
- `discoverySecurityGroup` (`nucleus-cloud-ops-discovery-sg`) — egress-only, all outbound for AWS API calls
- `discoveryTaskDef` (`nucleus-cloud-ops-discovery`) — ARM64 FARGATE, 256 CPU / 512 MiB, container env vars wired from Phase 8 resources
- `discoveryTriggerRule` (`nucleus-cloud-ops-discovery-trigger-rule`) — EventBridge Rule, source=`nucleus.app`, detail-type=`StartDiscovery`
- 4 new stack outputs: `discoveryTaskDefinitionArn`, `discoveryTaskRoleArn`, `discoveryExecutionRoleArn`, `discoverySecurityGroupId`

Task 2 ran `infra/build-lambdas.sh` (all 3 Lambda zips rebuilt) then `pulumi up --stack prod --yes`:
- 35 resources created, 32 unchanged
- Duration: 3m22s

## Stack Outputs (Phase 9 complete)

| Output | Value |
|--------|-------|
| schedulerLambdaArn | arn:aws:lambda:us-east-1:970547372609:function:nucleus-cloud-ops-function |
| vectorProcessorArn | arn:aws:lambda:us-east-1:970547372609:function:nucleus-cloud-ops-vector-processor |
| kbSyncProcessorArn | arn:aws:lambda:us-east-1:970547372609:function:nucleus-cloud-ops-kb-sync-processor |
| discoveryTaskDefinitionArn | arn:aws:ecs:us-east-1:970547372609:task-definition/nucleus-cloud-ops-discovery:1 |
| discoveryTaskRoleArn | arn:aws:iam::970547372609:role/nucleus-cloud-ops-discovery-task-role |
| discoveryExecutionRoleArn | arn:aws:iam::970547372609:role/nucleus-cloud-ops-discovery-execution-role |
| discoverySecurityGroupId | sg-020114b77393c228e |
| snsTopicArn | arn:aws:sns:us-east-1:970547372609:nucleus-cloud-ops-sns-topic |

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | ace63dd | feat(09-03): add Discovery ECS task def, IAM roles, SG, EventBridge Rule |
| 2 | (pulumi up — no repo file changes; state in S3) | — |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

- `discoveryImageUri` config is empty string — placeholder until real ECR image URI is set before Discovery runs (intentional, documented in plan)
- EventBridge Rule `discoveryTriggerRule` has no target — Phase 10 wires `aws.cloudwatch.EventTarget` when ECS cluster ARN exists (intentional, documented in plan)

## Self-Check: PASSED

- `infra/compute/index.ts` modified: FOUND
- Commit ace63dd: FOUND
- All 8 Phase 9 stack outputs present in `pulumi stack output --stack prod --json`: VERIFIED

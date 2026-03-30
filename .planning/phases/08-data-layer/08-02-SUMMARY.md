---
phase: 08-data-layer
plan: "02"
subsystem: infra/compute
tags: [pulumi, s3, sqs, cloudwatch, data-layer, infrastructure]
dependency_graph:
  requires: [08-01]
  provides: [4 S3 buckets, 4 SQS queues, 1 QueuePolicy, 1 CloudWatch alarm, appUrl config]
  affects: [08-03, phase-09, phase-10]
tech_stack:
  added: []
  patterns: ["aws.s3.BucketV2 + BucketLifecycleConfigurationV2", "aws.sqs.Queue with redrivePolicy", "aws.sqs.QueuePolicy (separate resource)", "aws.cloudwatch.MetricAlarm", "aws.getCallerIdentityOutput() for account ID", "pulumi.interpolate for bucket names"]
key_files:
  created: []
  modified:
    - infra/compute/index.ts
    - infra/compute/Pulumi.prod.yaml
decisions:
  - "Used aws.getCallerIdentityOutput() (returns Output<T>) instead of top-level await — tsconfig uses commonjs module which does not support top-level await"
  - "MetricAlarm uses name property not alarmName — auto-fixed TypeScript error (Rule 1)"
  - "BucketV2 and BucketLifecycleConfigurationV2 deprecation warnings are informational only — preview exits 0; migration to aws.s3.Bucket deferred (no behavior change)"
metrics:
  duration: "6 minutes"
  completed: "2026-03-30T08:47:37Z"
  tasks_completed: 2
  files_modified: 2
---

# Phase 8 Plan 2: S3 Buckets, SQS Queues, CloudWatch Alarm Summary

4 S3 buckets with lifecycle rules, 2 SQS queue pairs with DLQs, 1 QueuePolicy for S3→SQS, and 1 CloudWatch alarm defined in `infra/compute/index.ts`. `Pulumi.prod.yaml` updated with `appUrl` config. Preview shows 24 resources planned for creation.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add S3 buckets, SQS queues, CloudWatch alarm, and appUrl config | 83c0790 | infra/compute/index.ts, infra/compute/Pulumi.prod.yaml |
| 2 | Verify pulumi preview shows S3, SQS, and CloudWatch resources | (no file changes) | — |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] MetricAlarm property name mismatch**
- Found during: Task 1 TypeScript compile
- Issue: Plan specified `alarmName` but `@pulumi/aws` MetricAlarmArgs uses `name`
- Fix: Changed `alarmName` to `name` in MetricAlarm resource args
- Files modified: infra/compute/index.ts
- Commit: 83c0790

**2. [Rule 1 - Bug] Top-level await incompatible with commonjs module**
- Found during: Task 1 implementation
- Issue: Plan suggested `await aws.getCallerIdentity({})` but tsconfig uses `"module": "commonjs"` which does not support top-level await
- Fix: Used `aws.getCallerIdentityOutput({})` which returns `Output<T>` and works with `pulumi.interpolate` for bucket names
- Files modified: infra/compute/index.ts
- Commit: 83c0790

## Known Stubs

None — all resource names resolve to correct physical names (verified in preview output: `nucleus-cloud-ops-checkpoints-bucket-970547372609-us-east-1`, etc.).

## Self-Check: PASSED

- `infra/compute/index.ts` contains 4 `new aws.s3.BucketV2(` occurrences
- `infra/compute/index.ts` contains 4 `new aws.sqs.Queue(` occurrences
- `infra/compute/index.ts` contains `new aws.sqs.QueuePolicy(`
- `infra/compute/index.ts` contains `name: "nucleus-cloud-ops-vector-dlq-depth"`
- `infra/compute/Pulumi.prod.yaml` contains `nucleus-compute:appUrl`
- Commit 83c0790 exists
- `pulumi preview` exits 0 with 24 resources to create

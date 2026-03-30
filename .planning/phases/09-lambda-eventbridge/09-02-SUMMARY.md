---
phase: 09-lambda-eventbridge
plan: "09-02"
subsystem: infra
tags: [pulumi, lambda, sqs, s3, iam, eventbridge, vector-processor, kb-sync]

requires:
  - phase: 09-01
    provides: Scheduler Lambda + EventBridge rule already in infra/compute/index.ts
  - phase: 08-data-layer
    provides: inventoryBucket, kbStagingBucket, vectorProcessingQueue, kbSyncQueue, appTable, auditTable

provides:
  - VectorProcessor Lambda (nucleus-cloud-ops-vector-processor) with SQS trigger + S3 BucketNotification
  - KBSyncProcessor Lambda (nucleus-cloud-ops-kb-sync-processor) with SQS trigger
  - IAM roles for both Lambdas (S3, DynamoDB, Bedrock, S3Vectors, SQS permissions)
  - S3 BucketNotification wiring inventoryBucket normalized/ prefix to vectorProcessingQueue
  - Stack outputs: vectorProcessorArn, kbSyncProcessorArn

affects: [10-ecs-alb-cloudfront, 11-s3vectors-s3tables]

tech-stack:
  added: []
  patterns:
    - "aws.lambda.Function uses `name` property (not `functionName`) for physical name"
    - "SQS EventSourceMapping with scalingConfig.maximumConcurrency for concurrency control"
    - "aws.s3.BucketNotification as separate resource (not inline) when bucket created in prior phase"

key-files:
  created: []
  modified:
    - infra/compute/index.ts

key-decisions:
  - "aws.lambda.Function uses `name` not `functionName` — fixed during Task 1 TypeScript compile"
  - "VECTOR_BUCKET_ARN and KB_VECTOR_BUCKET_NAME are intentional placeholders — Phase 11 wires real S3 Vectors bucket"
  - "vectorBucketName added as Pulumi config key (nucleus-compute:vectorBucketName) for Phase 11 wiring"

patterns-established:
  - "Lambda IAM: separate RolePolicy resources per permission domain (s3, dynamodb, sqs, bedrock, s3vectors)"

requirements-completed: [PULUMI-09, PULUMI-10]

duration: 3min
completed: 2026-03-30
---

# Phase 09 Plan 02: VectorProcessor + KBSyncProcessor Lambdas Summary

**VectorProcessor (reservedConcurrentExecutions=10, SQS batchSize=1/maxConcurrency=5) and KBSyncProcessor (SQS batchSize=1) Lambdas deployed with IAM roles and S3 BucketNotification wiring inventoryBucket normalized/ prefix to vectorProcessingQueue**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-30T10:33:19Z
- **Completed:** 2026-03-30T10:35:39Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- VectorProcessor Lambda with reservedConcurrentExecutions=10, SQS trigger (batchSize=1, maxConcurrency=5), and full IAM role
- KBSyncProcessor Lambda with SQS trigger (batchSize=1) and full IAM role
- S3 BucketNotification on inventoryBucket routing normalized/ prefix events to vectorProcessingQueue

## Task Commits

1. **Tasks 1+2: VectorProcessor + KBSyncProcessor Lambdas** - `3c1b2de` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `infra/compute/index.ts` - Added VectorProcessor role+lambda+SQS trigger+S3 notification, KBSyncProcessor role+lambda+SQS trigger, stack outputs

## Decisions Made
- `aws.lambda.Function` uses `name` not `functionName` — caught by TypeScript compile, fixed inline (Rule 1 auto-fix)
- Placeholder values for VECTOR_BUCKET_ARN and KB_VECTOR_BUCKET_NAME are intentional — Phase 11 wires real S3 Vectors bucket

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed `functionName` → `name` in aws.lambda.Function**
- **Found during:** Task 1 (VectorProcessor Lambda)
- **Issue:** Plan template used `functionName` but Pulumi's `aws.lambda.Function` API uses `name` for the physical function name
- **Fix:** Changed `functionName` to `name` on both VectorProcessor and KBSyncProcessor Lambda resources
- **Files modified:** infra/compute/index.ts
- **Verification:** `npx tsc --noEmit` exits 0
- **Committed in:** 3c1b2de

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Required for TypeScript compilation. No scope creep.

## Known Stubs
- `infra/compute/index.ts` line 793: `VECTOR_BUCKET_ARN: ""` — intentional placeholder; Phase 11 wires real S3 Vectors bucket ARN
- `infra/compute/index.ts` line 953: `KB_VECTOR_BUCKET_NAME: vectorBucketName` where `vectorBucketName` defaults to `""` — intentional placeholder; Phase 11 wires real S3 Vectors bucket name

These stubs do not prevent the plan's goal (Lambda deployment). VectorProcessor and KBSyncProcessor will not process vectors until Phase 11 wires the S3 Vectors bucket.

## Issues Encountered
None beyond the `functionName` → `name` API fix.

## Next Phase Readiness
- Plan 09-03 (Discovery ECS task definition + EventBridge rule) can proceed
- Phase 10 can consume `vectorProcessorArn` and `kbSyncProcessorArn` stack outputs
- Phase 11 must set `nucleus-compute:vectorBucketName` config to wire real S3 Vectors bucket

---
*Phase: 09-lambda-eventbridge*
*Completed: 2026-03-30*

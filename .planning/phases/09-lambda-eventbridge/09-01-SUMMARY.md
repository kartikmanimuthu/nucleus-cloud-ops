---
phase: 09-lambda-eventbridge
plan: 09-01
subsystem: infra/compute
tags: [pulumi, lambda, eventbridge, sns, iam]
dependency_graph:
  requires: [08-data-layer]
  provides: [schedulerLambdaArn, snsTopicArn]
  affects: [infra/compute/index.ts]
tech_stack:
  added: [aws.lambda.Function, aws.sns.Topic, aws.cloudwatch.EventRule, aws.iam.Role]
  patterns: [pre-build script, FileArchive zip deployment, EventBridge cron trigger]
key_files:
  created:
    - infra/build-lambdas.sh
  modified:
    - infra/compute/index.ts
    - infra/compute/Pulumi.prod.yaml
    - .gitignore
    - package.json
decisions:
  - "npm ci required before esbuild for scheduler (uuid, dayjs, pg are non-AWS-SDK deps)"
  - "vector_processor esbuild runs from project root — no package.json, needs root node_modules for @aws-sdk/client-s3vectors and @prisma/client"
  - "Prisma externalized in vector_processor bundle + engine files copied into dist — binary cannot be bundled"
  - "lambda.zip files added to .gitignore — build artifacts, not source"
  - "aws.lambda.Function uses 'name' not 'functionName' in @pulumi/aws TypeScript types"
metrics:
  duration_minutes: 8
  completed_date: "2026-03-30"
  tasks_completed: 2
  files_changed: 5
---

# Phase 09 Plan 01: Scheduler Lambda + SNS + EventBridge Summary

Pulumi compute stack extended with SNS topic, Scheduler Lambda (ARM64/Node20, 15-min timeout), IAM role with DynamoDB+STS+SNS policies, and EventBridge cron rule — plus a pre-build script that bundles all 3 TypeScript Lambdas into deployable zips.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create Lambda pre-build script | 97b0a9d | infra/build-lambdas.sh, .gitignore, package.json |
| 2 | Add SNS + Scheduler Lambda + EventBridge to compute stack | ddc22c3 | infra/compute/index.ts, infra/compute/Pulumi.prod.yaml |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Scheduler Lambda build failed — missing npm ci**
- Found during: Task 1
- Issue: esbuild couldn't resolve `uuid`, `dayjs`, `pg` — non-AWS-SDK deps not installed
- Fix: Added `npm ci --omit=dev` before esbuild in `build_scheduler()`
- Files modified: infra/build-lambdas.sh
- Commit: 97b0a9d

**2. [Rule 1 - Bug] VectorProcessor build failed — no package.json, missing @aws-sdk/client-s3vectors**
- Found during: Task 1
- Issue: `lambda/vector_processor/` has no package.json; imports `@aws-sdk/client-s3vectors` (not installed anywhere) and `@prisma/client`
- Fix: Run esbuild from project root (resolves root node_modules); install `@aws-sdk/client-s3vectors` as root devDep; externalize `@prisma/client` + copy Prisma engine files into dist
- Files modified: infra/build-lambdas.sh, package.json
- Commit: 97b0a9d

**3. [Rule 1 - Bug] TypeScript error — `functionName` not a valid FunctionArgs property**
- Found during: Task 2
- Issue: `aws.lambda.Function` in @pulumi/aws uses `name` not `functionName`
- Fix: Renamed property to `name`
- Files modified: infra/compute/index.ts
- Commit: ddc22c3

## Known Stubs

None — all resources are fully wired. Lambda zip path (`../../lambda/scheduler/lambda.zip`) requires `infra/build-lambdas.sh` to be run before `pulumi up`.

## Self-Check: PASSED

- infra/build-lambdas.sh: FOUND
- infra/compute/index.ts: FOUND
- infra/compute/Pulumi.prod.yaml: FOUND
- commit 97b0a9d: FOUND
- commit ddc22c3: FOUND

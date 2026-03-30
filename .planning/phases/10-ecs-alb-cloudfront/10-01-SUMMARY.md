---
phase: 10-ecs-alb-cloudfront
plan: "01"
subsystem: infra
tags: [pulumi, ecs, ecr, fargate, iam, cloudwatch, arm64]

requires:
  - phase: 09-lambda-eventbridge
    provides: schedulerLambda ARN, discovery task def/role ARNs
  - phase: 08-data-layer
    provides: all DynamoDB table names, S3 bucket names, SQS queue URLs, Cognito IDs

provides:
  - ECR repository nucleus-cloud-ops-web-ui
  - ECS cluster nucleus-cloud-ops-ecs-cluster
  - ECS task execution role + task role with 7 IAM policies
  - WebUI task definition (ARM64, 512 CPU/1024 MiB) with 55 container env vars
  - infra/build-images.sh Docker build + ECR push script
  - Discovery task definition updated to 1024 CPU / 2048 MiB

affects: [10-02-alb-service, 10-03-cloudfront, 11-cutover]

tech-stack:
  added: ["@pulumi/random ^3.x"]
  patterns:
    - "pulumi.all() with 23 outputs for container env var wiring"
    - "config.requireSecret() for NEXTAUTH_SECRET encryption in Pulumi state"
    - "7 inline IAM policies on ECS task role (one per permission domain)"

key-files:
  created:
    - infra/build-images.sh
  modified:
    - infra/compute/index.ts
    - infra/compute/Pulumi.prod.yaml
    - infra/compute/package.json

key-decisions:
  - "webUiImageUri stored in Pulumi config (not hardcoded) — executor sets after running build-images.sh"
  - "nextauthSecret uses config.requireSecret() — KMS-encrypted in Pulumi state, not plaintext"
  - "Discovery task def updated 256/512 -> 1024/2048 to match CDK (Phase 9 deployed wrong values)"
  - "@pulumi/random imported now (Plan 03 CloudFront secret needs it — avoids import conflict later)"
  - "pulumi config set --secret nextauthSecret requires live AWS creds — deferred to operator"

patterns-established:
  - "pulumi.all([...23 outputs...]).apply() pattern for container definitions with secrets"
  - "Separate inline RolePolicy per permission domain (DynamoDB, S3, SQS, Bedrock, STS, S3Vectors, Logs)"

requirements-completed: [PULUMI-12]

duration: 18min
completed: "2026-03-30"
---

# Phase 10 Plan 01: ECS Cluster + Task Definition Summary

**ECR repo, ECS cluster, 7-policy task role, and WebUI task definition with 55 container env vars wired from Phase 8/9 stack outputs via pulumi.all()**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-03-30T11:20:00Z
- **Completed:** 2026-03-30T11:38:31Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- `infra/build-images.sh` — ECR create-if-missing + ARM64 docker build + push, outputs image URI for Pulumi config
- ECS cluster `nucleus-cloud-ops-ecs-cluster` with Container Insights, ECR repo `nucleus-cloud-ops-web-ui`, CloudWatch log group
- ECS task execution role + task role with 7 inline policies covering all required permission domains
- WebUI task definition `nucleus-cloud-ops-web-ui-task` (512 CPU / 1024 MiB, ARM64 FARGATE) with 55 env vars including encrypted NEXTAUTH_SECRET
- Discovery task definition corrected from 256/512 to 1024/2048 CPU/MiB to match CDK

## Task Commits

1. **Task 1: build-images.sh + @pulumi/random + Pulumi config keys** - `d5ac4b4` (feat)
2. **Task 2: ECR repo, ECS cluster, IAM roles, WebUI task definition** - `2412ae7` (feat)

## Files Created/Modified

- `infra/build-images.sh` — Docker build + ECR push script (chmod +x)
- `infra/compute/index.ts` — ECR repo, ECS cluster, log group, execution role, task role (7 policies), WebUI task def with 55 env vars; discovery task def cpu/memory corrected
- `infra/compute/Pulumi.prod.yaml` — added `nucleus-compute:webUiImageUri` config key
- `infra/compute/package.json` — added `@pulumi/random` dependency

## Decisions Made

- `config.requireSecret("nextauthSecret")` used so NEXTAUTH_SECRET is KMS-encrypted in Pulumi state — `pulumi config set --secret` requires live AWS credentials and must be run by the operator before `pulumi up`
- `@pulumi/random` imported at Task 2 (Plan 03 needs it for CloudFront origin verify secret — importing now avoids a future conflict)
- Discovery task def cpu/memory corrected inline (Phase 9 deployed 256/512; CDK uses 1024/2048)

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

- `pulumi config set --secret nextauthSecret` requires live AWS credentials (S3 state backend + KMS). Command was not run during execution — operator must run it before `pulumi up`. Documented in Pulumi.prod.yaml as a comment.

## Known Stubs

- `nucleus-compute:webUiImageUri: ""` — empty until operator runs `infra/build-images.sh` and sets the config value
- `VECTOR_BUCKET_NAME` and `KB_VECTOR_BUCKET_NAME` env vars set to `vectorBucketName || ""` — Phase 11 wires real S3 Vectors bucket ARN

## Next Phase Readiness

Plan 02 (ALB + ECS service) can proceed — it needs `ecsCluster.arn`, `ecsTaskRole.arn`, `ecsTaskExecutionRole.arn`, `webUiTaskDef.arn`, and `webUiLogGroup.name`, all now exported or available as local variables.

Operator prerequisite before `pulumi up`: run `cd infra/compute && pulumi config set --secret nextauthSecret "<value>"` and `infra/build-images.sh` then `pulumi config set webUiImageUri <uri>`.

---
*Phase: 10-ecs-alb-cloudfront*
*Completed: 2026-03-30*

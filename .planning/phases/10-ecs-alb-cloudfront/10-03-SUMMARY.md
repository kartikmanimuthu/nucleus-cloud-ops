---
phase: 10-ecs-alb-cloudfront
plan: 03
subsystem: infra
tags: [pulumi, cloudfront, ecs, alb, eventbridge, scheduler, aws]

requires:
  - phase: 10-ecs-alb-cloudfront/10-02
    provides: ALB, ECS service, auto scaling
  - phase: 09-lambda-eventbridge
    provides: discoveryTaskDef, discoveryTriggerRule, discoverySecurityGroup

provides:
  - CloudFront distribution (https://d11lr8aqp8vqde.cloudfront.net) in front of ALB
  - random.RandomString origin-verify-secret (stable across deploys)
  - Discovery EventBridge Scheduler (nucleus-cloud-ops-daily-discovery, cron 0 2 * * ? *)
  - On-demand discovery EventBridge rule wired to ECS cluster
  - Full Phase 10 stack outputs (ecsClusterArn, albDnsName, cloudFrontUrl, ecrRepositoryUri, etc.)

affects: [11-s3-vectors-cutover, phase-11]

tech-stack:
  added: ["@pulumi/random ^4.19.1 (already in package.json)"]
  patterns:
    - "random.RandomString for stable secrets — avoids CloudFront update on every preview"
    - "CloudFront caching disabled via defaultTtl/maxTtl=0 + forwardedValues headers=*"
    - "EventBridge Scheduler role reused for on-demand EventTarget"

key-files:
  created: []
  modified:
    - infra/compute/index.ts
    - infra/compute/Pulumi.prod.yaml

key-decisions:
  - "random.RandomString (not crypto.randomBytes) for origin verify secret — stable value prevents CloudFront replacement on every pulumi preview"
  - "Security group descriptions must use ASCII hyphens — AWS rejects non-ASCII characters (em dash caused 400 error)"
  - "webUiImageUri set after running infra/build-images.sh — ECR image 970547372609.dkr.ecr.us-east-1.amazonaws.com/nucleus-cloud-ops-web-ui:latest"
  - "Public ECR requires explicit auth (aws ecr-public get-login-password) before docker build"
  - "discoverySchedulerRole reused for both daily Schedule target and on-demand EventTarget"

requirements-completed: [PULUMI-12, PULUMI-13, PULUMI-14, PULUMI-15]

duration: 31min
completed: 2026-03-30
---

# Phase 10 Plan 03: CloudFront + Discovery Scheduler + Stack Outputs Summary

**CloudFront distribution with stable RandomString origin secret, daily Discovery EventBridge Scheduler at 2AM UTC, and all Phase 10 stack outputs deployed via pulumi up — CloudFront URL: https://d11lr8aqp8vqde.cloudfront.net**

## Performance

- **Duration:** 31 min
- **Started:** 2026-03-30T11:47:35Z
- **Completed:** 2026-03-30T12:18:42Z
- **Tasks:** 1 of 2 (Task 2 is human-verify checkpoint)
- **Files modified:** 2

## Accomplishments

- CloudFront distribution deployed with ALB origin, caching disabled, X-Origin-Verify header using `random.RandomString`
- Discovery EventBridge Scheduler (`nucleus-cloud-ops-daily-discovery`) running daily at 2AM UTC targeting ECS cluster
- On-demand `discoveryTriggerRule` wired to ECS cluster via `aws.cloudwatch.EventTarget`
- All Phase 10 stack outputs exported: `ecsClusterArn`, `ecsClusterName`, `webUiServiceName`, `albDnsName`, `albArn`, `cloudFrontUrl`, `cloudFrontDistributionId`, `ecrRepositoryUri`, `originVerifySecretValue`
- WebUI Docker image built (ARM64) and pushed to ECR: `nucleus-cloud-ops-web-ui:latest`
- `pulumi up` completed: 10 created, 86 unchanged

## Task Commits

1. **Task 1: CloudFront, Discovery Scheduler, stack outputs + pulumi up** - `4ea7ee1` (feat)

## Files Created/Modified

- `infra/compute/index.ts` — Added CloudFront distribution, origin verify secret, Discovery Scheduler, EventTarget, Phase 10 stack outputs; fixed security group descriptions
- `infra/compute/Pulumi.prod.yaml` — Added nextauthSecret (secret) and webUiImageUri config values

## Decisions Made

- `random.RandomString` for origin verify secret — `crypto.randomBytes` generates a new value on every `pulumi preview`, causing CloudFront replacement on every deploy
- Security group descriptions must use ASCII hyphens — AWS EC2 API rejects non-ASCII characters (em dash `—` caused 400 InvalidParameterValue)
- Public ECR requires explicit `aws ecr-public get-login-password` auth before `docker build` — not covered by private ECR login
- `discoverySchedulerRole` reused for both the daily `aws.scheduler.Schedule` target and the on-demand `aws.cloudwatch.EventTarget` — both need `ecs:RunTask` + `iam:PassRole`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed non-ASCII characters in security group descriptions**
- **Found during:** Task 1 (pulumi up)
- **Issue:** ALB and ECS service security group descriptions contained em dashes (`—`), which AWS EC2 API rejects with `InvalidParameterValue: Character sets beyond ASCII are not supported`
- **Fix:** Replaced em dashes with ASCII hyphens in both security group `description` fields
- **Files modified:** `infra/compute/index.ts`
- **Verification:** `pulumi up` succeeded after fix
- **Committed in:** `4ea7ee1` (Task 1 commit)

**2. [Rule 3 - Blocking] Set webUiImageUri config and built ECR image**
- **Found during:** Task 1 (pulumi up)
- **Issue:** `webUiImageUri` was empty string — ECS task definition registration fails with `Container.image should not be null or empty`
- **Fix:** Ran `infra/build-images.sh` to build ARM64 image and push to ECR; set `webUiImageUri` in Pulumi config
- **Files modified:** `infra/compute/Pulumi.prod.yaml`
- **Verification:** `pulumi up` succeeded, ECS task definition created at revision 1
- **Committed in:** `4ea7ee1` (Task 1 commit)

**3. [Rule 3 - Blocking] Authenticated to public ECR before docker build**
- **Found during:** Task 1 (build-images.sh)
- **Issue:** `docker build` failed with 403 Forbidden on `public.ecr.aws/docker/library/node:20.9.0-slim` — public ECR requires separate auth
- **Fix:** Ran `aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws`
- **Files modified:** None
- **Verification:** Build succeeded after auth
- **Committed in:** `4ea7ee1` (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (1 bug, 2 blocking)
**Impact on plan:** All fixes necessary for deployment. No scope creep.

## Issues Encountered

- `nextauthSecret` not set in Pulumi config — first `pulumi preview` failed; set via `pulumi config set --secret`
- Public ECR auth required separately from private ECR auth

## Known Stubs

None — all wired values are real. `VECTOR_BUCKET_NAME` and `KB_VECTOR_BUCKET_NAME` remain empty string placeholders (intentional — Phase 11 wires real S3 Vectors bucket, documented in STATE.md decisions).

## Next Phase Readiness

- CloudFront URL: `https://d11lr8aqp8vqde.cloudfront.net` (ECS service desiredCount=0 — scale up after smoke testing)
- ALB DNS: `nucleus-cloud-ops-alb-1695003014.us-east-1.elb.amazonaws.com`
- ECR image ready: `970547372609.dkr.ecr.us-east-1.amazonaws.com/nucleus-cloud-ops-web-ui:latest`
- Phase 11 can consume `cloudFrontUrl`, `albDnsName`, `ecsClusterArn` via stack outputs
- Human verification (Task 2) required before marking Phase 10 complete

---
*Phase: 10-ecs-alb-cloudfront*
*Completed: 2026-03-30*

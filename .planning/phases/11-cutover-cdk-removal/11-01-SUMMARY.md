---
phase: 11-cutover-cdk-removal
plan: 01
subsystem: infra
tags: [pulumi, typescript, env, cognito, dynamodb, s3, cloudfront]

requires:
  - phase: 10-ecs-alb-cloudfront
    provides: cloudFrontUrl, albDnsName, ecsClusterArn, ecrRepositoryUri, originVerifySecretValue
  - phase: 08-data-layer
    provides: DynamoDB table names, S3 bucket names, Cognito pool outputs
  - phase: 09-lambda-eventbridge
    provides: schedulerLambdaArn, SQS queue URLs

provides:
  - scripts/generate-env.ts — reads pulumi stack output and writes web-ui/.env.local

affects: [11-02, 11-03, local-dev-setup]

tech-stack:
  added: []
  patterns:
    - "pulumi stack output --json --show-secrets piped into env file generator"
    - "Static + dynamic env var split: dynamic from Pulumi outputs, static hardcoded"

key-files:
  created:
    - scripts/generate-env.ts
  modified: []

key-decisions:
  - "Use --show-secrets flag to resolve cognitoUserPoolClientSecret from [secret] to real value"
  - "Write to web-ui/.env.local (gitignored), not root .env"
  - "Construct COGNITO_DOMAIN from cognitoDomainPrefix + .auth.us-east-1.amazoncognito.com"
  - "Exit 1 with helpful message if pulumi CLI not found"

patterns-established:
  - "generate-env.ts pattern: execSync pulumi output -> map keys -> writeFileSync"

requirements-completed: [PULUMI-16]

duration: 2min
completed: 2026-03-30
---

# Phase 11 Plan 01: Generate-Env Script Summary

**`scripts/generate-env.ts` reads all Pulumi compute stack outputs via `--show-secrets` and writes a complete `web-ui/.env.local` with 30+ env vars mapped from DynamoDB tables, S3 buckets, Cognito, CloudFront, and static defaults.**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-30T13:50:26Z
- **Completed:** 2026-03-30T13:51:57Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Created `scripts/generate-env.ts` with all 20+ dynamic Pulumi output mappings from CONTEXT.md
- Included all 12 static values (AWS_REGION, BEDROCK_MODEL_ID, NODE_ENV, etc.)
- Cognito domain constructed from prefix (`${prefix}.auth.us-east-1.amazoncognito.com`)
- TypeScript compiles cleanly; all acceptance criteria pass

## Task Commits

1. **Task 1: Create generate-env.ts script** - `f7a7584` (feat)

## Files Created/Modified
- `scripts/generate-env.ts` - Pulumi stack output → web-ui/.env.local generator

## Decisions Made
None beyond what was locked in CONTEXT.md — followed plan as specified.

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `scripts/generate-env.ts` ready for use: `npx tsx scripts/generate-env.ts`
- Phase 11-02 (S3 Vectors + S3 Tables CFN wrapping) can proceed independently

---
*Phase: 11-cutover-cdk-removal*
*Completed: 2026-03-30*

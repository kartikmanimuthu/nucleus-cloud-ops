---
phase: 11-cutover-cdk-removal
plan: "03"
subsystem: infra
tags: [cdk, pulumi, networking, compute, webui, cutover]

requires:
  - phase: 11-cutover-cdk-removal/11-01
    provides: generate-env.ts and S3 Vectors CFN wrapping
  - phase: 11-cutover-cdk-removal/11-02
    provides: Pulumi compute stack fully deployed

provides:
  - bin/webUIStack.ts — new CDK entry point for WebUIStack only
  - cdk.json updated to bin/webUIStack.ts
  - lib/networkingStack.ts deleted
  - lib/computeStack.ts deleted
  - bin/cdkStack.ts deleted
  - Manual CDK destroy instructions for NetworkingStack + ComputeStack

affects: [future CDK deploys, WebUIStack, CDK dependency cleanup]

tech-stack:
  added: []
  patterns:
    - CDK scoped to WebUIStack only — Pulumi owns networking and compute

key-files:
  created:
    - bin/webUIStack.ts
  modified:
    - cdk.json
  deleted:
    - lib/networkingStack.ts
    - lib/computeStack.ts
    - bin/cdkStack.ts

key-decisions:
  - "bin/webUIStack.ts omits schedulerLambdaArn — optional prop, can be wired via CDK context later if needed"
  - "CDK package.json dependencies preserved — WebUIStack still requires aws-cdk-lib, constructs, etc."
  - "cdk synth uses AWS_PROFILE env var (not --profile flag) — --profile is a stack selector in CDK CLI"

patterns-established:
  - "CDK entry point pattern: single-stack bin/ file importing only the relevant stack + getConfig()"

requirements-completed:
  - PULUMI-17

duration: 3min
completed: "2026-03-30"
---

# Phase 11 Plan 03: CDK Cleanup — NetworkingStack + ComputeStack Removed Summary

**CDK scoped to WebUIStack only: networkingStack.ts, computeStack.ts, and cdkStack.ts deleted; new bin/webUIStack.ts entry point verified with cdk synth**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-03-30T14:00:15Z
- **Completed:** 2026-03-30T14:03:22Z
- **Tasks:** 2 of 3 (Task 3 is human checkpoint)
- **Files modified:** 5 (2 created/modified, 3 deleted)

## Accomplishments

- Created `bin/webUIStack.ts` — minimal CDK entry point instantiating WebUIStack only
- Updated `cdk.json` app field to point to `bin/webUIStack.ts`
- Deleted `lib/networkingStack.ts`, `lib/computeStack.ts`, `bin/cdkStack.ts` (1610 lines removed)
- Verified `npx cdk synth` exits 0 and `npx cdk list` shows only `nucleus-cloud-ops-WebUIStack`

## Task Commits

1. **Task 1: Create bin/webUIStack.ts and update cdk.json** - `1282ae2` (feat)
2. **Task 2: Delete CDK NetworkingStack and ComputeStack source files** - `687d2f4` (chore)

## Files Created/Modified

- `bin/webUIStack.ts` — new CDK entry point, WebUIStack only
- `cdk.json` — app field updated to `bin/webUIStack.ts`
- `lib/networkingStack.ts` — deleted
- `lib/computeStack.ts` — deleted
- `bin/cdkStack.ts` — deleted

## Decisions Made

- `bin/webUIStack.ts` omits `schedulerLambdaArn` — it's an optional prop on WebUIStack; can be wired via CDK context if needed later
- CDK npm dependencies left intact — WebUIStack still needs `aws-cdk-lib`, `constructs`, `@aws-cdk/aws-s3tables-alpha`, `cdk-s3-vectors`, `source-map-support`
- Used `AWS_PROFILE` env var for `cdk synth` (not `--profile` flag) — confirmed from Phase 11 STATE.md decision

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

- `npx cdk synth --profile PLATFORM-ADMIN` returned "No stacks match the name(s) PLATFORM-ADMIN" — `--profile` is a stack selector in CDK CLI, not an AWS profile flag. Used `AWS_PROFILE=PLATFORM-ADMIN` env var instead. This matches the existing STATE.md decision from Phase 11.

## User Setup Required

**Manual CDK destroy required when ready.** After confirming Pulumi stacks are healthy and serving traffic:

```bash
# Step 1: Destroy ComputeStack first (depends on NetworkingStack)
npx cdk destroy nucleus-cloud-ops-ComputeStack --profile PLATFORM-ADMIN

# Step 2: Destroy NetworkingStack after ComputeStack is gone
npx cdk destroy nucleus-cloud-ops-NetworkingStack --profile PLATFORM-ADMIN
```

**Warning:** Only run after:
- Pulumi ECS service is running and serving traffic via CloudFront
- `generate-env.ts` produces a working `.env.local`
- S3 Vectors + S3 Tables CFN stacks deployed via Pulumi

**Note:** CDK destroy may fail if resources have dependencies outside the stack (e.g., ENIs in VPC subnets from Pulumi ECS tasks). If so, manually delete the dependent resources first, then retry destroy.

## Next Phase Readiness

- CDK is now scoped to WebUIStack only — Pulumi owns all networking and compute
- Manual CDK destroy of NetworkingStack + ComputeStack is the final cutover step
- No blockers

---
*Phase: 11-cutover-cdk-removal*
*Completed: 2026-03-30*

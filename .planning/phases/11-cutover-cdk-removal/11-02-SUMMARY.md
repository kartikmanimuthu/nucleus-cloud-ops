---
phase: 11-cutover-cdk-removal
plan: "02"
subsystem: infra
tags: [pulumi, cloudformation, s3-vectors, s3-tables, iceberg, cdk-synth]

requires:
  - phase: 10-ecs-alb-cloudfront
    provides: compute index.ts with Phase 10 exports as append point

provides:
  - S3 Vectors bucket + 2 indexes wrapped in aws.cloudformation.Stack
  - S3 Tables TableBucket + namespace + Iceberg table wrapped in aws.cloudformation.Stack
  - infra/compute/s3-vectors-template.json (21 resources extracted from cdk synth)
  - infra/compute/s3-tables-template.json (3 resources extracted from cdk synth)

affects: [11-03-cdk-removal, pulumi-cutover]

tech-stack:
  added: [aws.cloudformation.Stack, node:fs, node:path]
  patterns: [cdk-synth-extract-wrap — run cdk synth, extract resource subset, wrap in Pulumi CFN stack]

key-files:
  created:
    - infra/compute/s3-vectors-template.json
    - infra/compute/s3-tables-template.json
  modified:
    - infra/compute/index.ts

key-decisions:
  - "S3 Vectors CFN template includes 21 resources: VectorBucket custom resource + 2 index custom resources with their Lambda-backed providers and IAM roles"
  - "S3 Tables CFN template is minimal: 3 native CFN resources (TableBucket, Namespace, Table) with no custom resource providers needed"
  - "Only external refs in vectors template are AWS::Partition pseudo-params — valid in standalone CFN, no hardcoding needed"
  - "templateBody read via fs.readFileSync at deploy time (inline), not S3-hosted — per CONTEXT.md locked decision"
  - "CAPABILITY_IAM required on both stacks — vectors template has Lambda-backed custom resource IAM roles"

patterns-established:
  - "cdk-synth-extract: run cdk synth with APP_NAME/AWS_ACCOUNT_ID/AWS_REGION env vars + AWS_PROFILE; extract resource subset by key; verify no external Ref/GetAtt outside the subset"
  - "cfn-wrap: aws.cloudformation.Stack with inline templateBody + CAPABILITY_IAM for any template containing IAM resources"

requirements-completed: [PULUMI-18]

duration: 12min
completed: "2026-03-30"
---

# Phase 11 Plan 02: S3 Vectors + S3 Tables CFN Wrappers Summary

**S3 Vectors (bucket + 2 indexes) and S3 Tables (TableBucket + namespace + Iceberg table) wrapped in `aws.cloudformation.Stack` resources — `pulumi preview` confirms both stacks as new additions with no existing resource changes**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-03-30T13:57:00Z
- **Completed:** 2026-03-30T14:09:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Ran `cdk synth` with required env vars to generate `cdk.out/nucleus-app-ComputeStack.template.json`
- Extracted 21 S3 Vectors resources (VectorBucket + text-embeddings + knowledge-base-embeddings indexes with Lambda-backed custom resource providers) into `s3-vectors-template.json`
- Extracted 3 S3 Tables resources (TableBucket + Namespace + Table) into `s3-tables-template.json`
- Added `aws.cloudformation.Stack` wrappers to `infra/compute/index.ts` with `fs`/`path` imports and `CAPABILITY_IAM`
- `pulumi preview` shows exactly 2 new `aws:cloudformation:Stack` resources, no existing resources affected

## Task Commits

1. **Task 1: Extract CFN templates from cdk synth output** - `f7f641a` (feat)
2. **Task 2: Add aws.cloudformation.Stack resources to compute index.ts** - `70f6731` (feat)

## Files Created/Modified

- `infra/compute/s3-vectors-template.json` — 21-resource CFN template: VectorBucket custom resource + 2 vector index custom resources with Lambda providers and IAM roles
- `infra/compute/s3-tables-template.json` — 3-resource CFN template: TableBucket, Namespace, Iceberg Table (native CFN types, no custom resources)
- `infra/compute/index.ts` — added `fs`/`path` imports + Phase 11 CFN stack wrappers appended after Phase 10 exports

## Decisions Made

- `cdk synth` requires `APP_NAME`, `AWS_ACCOUNT_ID`, `AWS_REGION` env vars and `AWS_PROFILE` — the `--profile` flag is a stack selector, not a credentials flag
- S3 Vectors uses alpha CDK constructs backed by Lambda custom resources; the full provider chain (handler Lambda + provider framework Lambda + IAM roles + policies + CustomResource) must all be included in the extracted template
- S3 Tables uses native `AWS::S3Tables::*` CFN types — no custom resources needed, template is minimal
- `AWS::Partition` pseudo-parameter refs in IAM managed policy ARNs are valid in standalone CFN templates — no hardcoding required

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

- `npx cdk synth --profile PLATFORM-ADMIN` failed: CDK treats the argument after `synth` as a stack name filter, not a credentials profile. Fix: use `AWS_PROFILE=PLATFORM-ADMIN` env var instead.
- `cdk synth` also required `APP_NAME`, `AWS_ACCOUNT_ID`, `AWS_REGION` env vars (config.ts throws without them). Fix: set all three inline.

## Next Phase Readiness

- Both CFN stacks ready for `pulumi up` deployment
- Phase 11-03 (CDK removal) can proceed — Pulumi now manages all resources previously owned by CDK ComputeStack
- Vector processor Lambda env vars `VECTOR_BUCKET_ARN` / `KB_VECTOR_BUCKET_NAME` still reference placeholder values from Phase 9 — Phase 11-03 should wire these from the CFN stack outputs

---
*Phase: 11-cutover-cdk-removal*
*Completed: 2026-03-30*

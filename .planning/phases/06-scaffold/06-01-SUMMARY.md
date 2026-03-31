---
phase: 06-scaffold
plan: 01
subsystem: infra
tags: [pulumi, aws, s3-backend, kms, typescript, iac]

requires: []
provides:
  - infra/bootstrap/bootstrap.sh for one-time S3 state bucket + KMS key creation
  - infra/networking/ Pulumi TypeScript project with S3 backend and placeholder exports
  - infra/compute/ Pulumi TypeScript project with StackReference to networking
affects: [07-networking, 08-data-layer, 09-lambda-eventbridge, 10-ecs-alb-cloudfront, 11-cutover]

tech-stack:
  added: ["@pulumi/pulumi ^3.228.0", "@pulumi/aws ^7.23.0", "typescript ~5.6.2"]
  patterns:
    - "Two independent Pulumi projects in infra/networking/ and infra/compute/"
    - "S3 backend (s3://nucleus-pulumi-state) with KMS secrets provider"
    - "StackReference format: nucleus-networking/prod (no org prefix for S3 backend)"
    - "commonjs module in Pulumi tsconfig to avoid conflict with root CDK tsconfig"

key-files:
  created:
    - infra/bootstrap/bootstrap.sh
    - infra/networking/package.json
    - infra/networking/tsconfig.json
    - infra/networking/Pulumi.yaml
    - infra/networking/Pulumi.prod.yaml
    - infra/networking/index.ts
    - infra/compute/package.json
    - infra/compute/tsconfig.json
    - infra/compute/Pulumi.yaml
    - infra/compute/Pulumi.prod.yaml
    - infra/compute/index.ts
  modified: []

key-decisions:
  - "infra/ subdirectory isolation prevents tsconfig module conflict between CDK (commonjs) and Pulumi"
  - "getOutput() used in compute StackReference (not requireOutput()) — networking has placeholder values during scaffold"
  - "No @pulumi/awsx or @pulumi/cdk — @pulumi/aws primitives only for 1:1 CDK parity verification"

patterns-established:
  - "Pulumi.yaml backend.url: s3://nucleus-pulumi-state?region=us-east-1&awssdk=v2"
  - "StackReference name format for S3 backend: <project>/<stack> (no org prefix)"
  - "Placeholder exports in networking/index.ts — replaced with real outputs in Phase 7"

requirements-completed: [PULUMI-01]

duration: 8min
completed: 2026-03-29
---

# Phase 06 Plan 01: Pulumi Scaffold Summary

**Two Pulumi TypeScript projects (networking + compute) with S3 backend, KMS secrets, and StackReference wiring — plus one-time bootstrap script**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-29T09:53:54Z
- **Completed:** 2026-03-29T10:01:00Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- Bootstrap script creates S3 state bucket (versioned, public-access-blocked) + KMS key/alias + pulumi login
- networking project: valid Pulumi TypeScript with S3 backend, placeholder VPC/subnet exports
- compute project: mirrors networking structure, adds StackReference to nucleus-networking/prod

## Task Commits

1. **Task 1: Bootstrap script and networking project scaffold** - `d52b482` (feat)
2. **Task 2: Compute project scaffold** - `d22fa4e` (feat)

## Files Created/Modified
- `infra/bootstrap/bootstrap.sh` - One-time S3 bucket + KMS key creation, pulumi login (executable)
- `infra/networking/package.json` - @pulumi/pulumi ^3.228.0, @pulumi/aws ^7.23.0
- `infra/networking/tsconfig.json` - commonjs, strict, ES2020
- `infra/networking/Pulumi.yaml` - S3 backend s3://nucleus-pulumi-state
- `infra/networking/Pulumi.prod.yaml` - aws:region us-east-1
- `infra/networking/index.ts` - Placeholder exports: vpcId, vpcCidr, publicSubnetIds, privateSubnetIds, databaseSubnetIds, intraSubnetIds
- `infra/compute/package.json` - Identical versions to networking
- `infra/compute/tsconfig.json` - Identical to networking
- `infra/compute/Pulumi.yaml` - S3 backend s3://nucleus-pulumi-state
- `infra/compute/Pulumi.prod.yaml` - aws:region us-east-1
- `infra/compute/index.ts` - StackReference("nucleus-networking/prod"), getOutput() for VPC/subnet IDs

## Decisions Made
- Used `getOutput()` not `requireOutput()` in compute StackReference — networking stack has placeholder values during scaffold; Phase 8+ will switch to `requireOutput()` when real resources exist
- `infra/` subdirectory isolation: Pulumi tsconfig uses `"module": "commonjs"` (Pulumi runtime requirement), which matches root CDK tsconfig — no conflict

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
Before running any `pulumi up`, run the bootstrap script once:
```bash
cd infra/bootstrap && ./bootstrap.sh
```
Then initialize stacks:
```bash
cd infra/networking && npm install && pulumi stack init prod --secrets-provider='awskms://alias/pulumi-secrets'
cd infra/compute && npm install && pulumi stack init prod --secrets-provider='awskms://alias/pulumi-secrets'
```

## Next Phase Readiness
- Phase 7 (networking): infra/networking/ scaffold ready — add VPC, subnets, NAT gateway, VPC endpoints, replace placeholder exports
- Phase 8+ (compute): infra/compute/ scaffold ready — StackReference wired, switch getOutput() to requireOutput() when networking has real values

---
*Phase: 06-scaffold*
*Completed: 2026-03-29*

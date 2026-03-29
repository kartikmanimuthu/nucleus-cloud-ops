---
phase: 07-networking
plan: 01
subsystem: infra
tags: [pulumi, awsx, vpc, networking, aws-ec2, rds, elasticache]

requires:
  - phase: 06-scaffold
    provides: infra/networking/ and infra/compute/ Pulumi project scaffolds with placeholder outputs

provides:
  - awsx.ec2.Vpc "nucleus-vpc" with 4-tier subnets and explicit CIDRs
  - S3 and DynamoDB gateway VPC endpoints
  - RDS subnet group nucleus-db-subnet-group
  - ElastiCache subnet group nucleus-cache-subnet-group
  - 9 stack outputs matching CDK CfnOutput keys
  - infra/compute/index.ts wired to requireOutput() for all networking outputs

affects:
  - 07-02 (pulumi up networking)
  - 07-03 (pulumi preview compute)
  - 08-data-layer
  - 09-lambda
  - 10-ecs

tech-stack:
  added:
    - "@pulumi/awsx@^3.3.1"
  patterns:
    - "awsx.ec2.Vpc component for 4-tier subnet architecture"
    - "Filter vpc.subnets by Name tag to separate Isolated subnet tiers"
    - "aws.ec2.VpcEndpoint (Gateway type) for S3 and DynamoDB — awsx does not support addGatewayEndpoint"
    - "Explicit physical names on subnet groups to prevent Pulumi 7-char suffix"
    - "requireOutput() in compute StackReference enforces networking-must-deploy-first constraint"

key-files:
  created: []
  modified:
    - infra/networking/package.json
    - infra/networking/Pulumi.prod.yaml
    - infra/networking/index.ts
    - infra/compute/index.ts

key-decisions:
  - "Use awsx.ec2.Vpc component (not raw aws.ec2.* primitives) — matches CDK ec2.Vpc abstraction level"
  - "Filter databaseSubnetIds and intraSubnetIds from vpc.subnets by Name tag — vpc.isolatedSubnetIds merges all Isolated tiers"
  - "endpointRouteTableIds built from private + database + intra subnets via aws.ec2.getRouteTableOutput"
  - "vpcCidrConfig local variable avoids duplicate identifier with vpcCidr export"

patterns-established:
  - "Subnet tag filtering: pulumi.all([s.id, s.tags]).apply() to resolve both outputs before filtering"
  - "Gateway endpoints: raw aws.ec2.VpcEndpoint with routeTableIds from getRouteTableOutput lookup"

requirements-completed:
  - PULUMI-02
  - PULUMI-03

duration: 3min
completed: 2026-03-29
---

# Phase 07 Plan 01: Networking Implementation Summary

**awsx.ec2.Vpc "nucleus-vpc" with 4-tier subnets, S3/DynamoDB gateway endpoints, RDS+ElastiCache subnet groups, and 9 stack outputs wired into compute via requireOutput()**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-29T16:28:02Z
- **Completed:** 2026-03-29T16:31:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Replaced Phase 6 placeholder in infra/networking/index.ts with full awsx.ec2.Vpc implementation
- Added S3 and DynamoDB gateway VPC endpoints using raw aws.ec2.VpcEndpoint (awsx does not expose addGatewayEndpoint)
- Updated infra/compute/index.ts from getOutput() to requireOutput() for all 9 networking outputs

## Task Commits

1. **Task 1: Add @pulumi/awsx dep and VPC config keys** - `9581d84` (chore)
2. **Task 2: Implement networking program and update compute StackReference** - `779a421` (feat)

## Files Created/Modified

- `infra/networking/package.json` - Added @pulumi/awsx@^3.3.1 dependency
- `infra/networking/Pulumi.prod.yaml` - Added nucleus-networking:vpcCidr, maxAzs, natGateways config keys
- `infra/networking/index.ts` - Full networking implementation: awsx.ec2.Vpc, VPC endpoints, subnet groups, 9 exports
- `infra/compute/index.ts` - Switched to requireOutput() for all 9 networking outputs; added missing intraSubnetIds, availabilityZones, dbSubnetGroupName, cacheSubnetGroupName

## Decisions Made

- Used `vpcCidrConfig` as the local config variable name to avoid a TypeScript duplicate identifier error with the `vpcCidr` export
- Filtered `databaseSubnetIds` and `intraSubnetIds` from `vpc.subnets` by Name tag rather than using `vpc.isolatedSubnetIds` — awsx merges all Isolated-type subnets into a single array, making the two tiers indistinguishable
- Built `endpointRouteTableIds` by calling `aws.ec2.getRouteTableOutput({ subnetId })` for each private + database + intra subnet, then deduplicating — this is the correct pattern since awsx does not expose route table IDs directly

## Deviations from Plan

None — plan executed exactly as written. The plan's note about the `vpcCidrOutput` duplicate identifier was pre-empted by using `vpcCidrConfig` as the local variable name from the start.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required. `pulumi up` for the networking stack runs in Plan 07-02.

## Next Phase Readiness

- infra/networking/index.ts is ready to deploy via `pulumi up` (Plan 07-02)
- infra/compute/index.ts will fail `pulumi preview` until networking stack is deployed (requireOutput() enforces this — expected behavior)
- All 9 CDK-matching outputs are defined; downstream phases (08, 09, 10) can reference them via StackReference

---
*Phase: 07-networking*
*Completed: 2026-03-29*

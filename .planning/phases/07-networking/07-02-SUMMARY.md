---
phase: 07-networking
plan: 02
subsystem: infra
tags: [pulumi, awsx, vpc, networking, preview]

requires:
  - phase: 07-01
    provides: infra/networking/index.ts with awsx.ec2.Vpc program

provides:
  - "@pulumi/awsx installed in infra/networking/node_modules/"
  - "pulumi preview --stack prod exits 0 with 40 resources planned"
  - "All 9 stack outputs confirmed present in preview"

affects: [07-03, 08-data-layer, 09-lambda, 10-compute]

tech-stack:
  added: ["@pulumi/awsx@3.3.1 (runtime installed)"]
  patterns: ["pulumi preview as pre-deploy verification gate before pulumi up"]

key-files:
  created: []
  modified:
    - infra/networking/package-lock.json

key-decisions:
  - "awsx subnet naming confirmed as nucleus-vpc-<spec-name>-<index> (e.g. nucleus-vpc-database-1) — Name tag filter in index.ts is correct"
  - "40 resources is the expected count for 4-tier VPC with 2 AZs, 2 NAT gateways, 2 VPC endpoints, 2 subnet groups"
  - "[unknown] outputs for subnet/VPC IDs in preview are expected — they resolve at pulumi up time"

patterns-established:
  - "Run pulumi preview --stack prod --non-interactive before pulumi up to catch TypeScript/API errors early"

requirements-completed: [PULUMI-02]

duration: 25min
completed: 2026-03-29
---

# Phase 07 Plan 02: npm install + pulumi preview Summary

**@pulumi/awsx installed and pulumi preview confirms 40-resource networking plan (VPC, 8 subnets, 2 NAT gateways, 2 VPC endpoints, 2 subnet groups) with all 9 stack outputs — zero TypeScript errors**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-03-29T18:30:00Z
- **Completed:** 2026-03-29T18:55:11Z
- **Tasks:** 1
- **Files modified:** 1 (package-lock.json)

## Accomplishments
- `@pulumi/awsx@3.3.1` installed in `infra/networking/node_modules/`
- `pulumi preview --stack prod` exits 0 with 40 resources planned, no errors
- Confirmed awsx subnet naming format: `nucleus-vpc-database-1/2` and `nucleus-vpc-intra-1/2` — Name tag filter in `index.ts` is correct as-is
- All 9 stack outputs present: vpcId, vpcCidr, publicSubnetIds, privateSubnetIds, databaseSubnetIds, intraSubnetIds, availabilityZones, dbSubnetGroupName, cacheSubnetGroupName

## Task Commits

1. **Task 1: npm install and pulumi preview** - `5828f26` (chore)

**Plan metadata:** (this commit)

## Files Created/Modified
- `infra/networking/package-lock.json` - lockfile updated with @pulumi/awsx@3.3.1 and transitive deps

## Decisions Made
- awsx names Isolated subnets using the `name` field from `subnetSpecs` (not the `type`), so `nucleus-vpc-database-1` and `nucleus-vpc-intra-1` are the actual resource names. The `.includes("-database-")` and `.includes("-intra-")` filters in `index.ts` are correct.
- `[unknown]` values for vpcId, publicSubnetIds, privateSubnetIds, databaseSubnetIds, intraSubnetIds in preview output are expected — these are computed at deploy time, not preview time.

## Deviations from Plan

None - plan executed exactly as written. No TypeScript errors required fixing.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `infra/networking/` is ready for `pulumi up --stack prod` (Plan 07-03)
- Preview confirms resource plan is correct — no surprises expected at deploy time
- Subnet Name tag filter verified correct — databaseSubnetIds and intraSubnetIds will each resolve to 2 IDs

---
*Phase: 07-networking*
*Completed: 2026-03-29*

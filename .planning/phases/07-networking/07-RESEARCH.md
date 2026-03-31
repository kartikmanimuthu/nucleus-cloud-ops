# Phase 7: Networking — Research

**Researched:** 2026-03-29
**Domain:** @pulumi/awsx Vpc component, aws.ec2.VpcEndpoint (gateway), aws.rds.SubnetGroup, aws.elasticache.SubnetGroup
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- Use `@pulumi/awsx` `Vpc` component — NOT raw `@pulumi/aws` primitives
- Component name: `nucleus-vpc` (drives all child resource names)
- Drop `-app` suffix; use `nucleus-*` prefix
- Explicit physical names on: RDS subnet group (`nucleus-db-subnet-group`), ElastiCache subnet group (`nucleus-cache-subnet-group`), VPC endpoints (`nucleus-endpoint-s3`, `nucleus-endpoint-dynamodb`)
- VPC CIDR: `10.0.0.0/16`, 2 AZs (`us-east-1a`, `us-east-1b`), DNS hostnames + support enabled
- 4-tier subnets: Public /24, Private /22, Database /24, Intra /26 (2 subnets each)
- 2 NAT gateways (one per AZ)
- Gateway endpoints only: S3 + DynamoDB, routes from Private + Database + Intra subnets
- RDS subnet group + ElastiCache subnet group using Database tier subnets
- Stack outputs match CDK CfnOutputs exactly (vpcId, vpcCidr, publicSubnetIds, privateSubnetIds, databaseSubnetIds, intraSubnetIds, availabilityZones, dbSubnetGroupName, cacheSubnetGroupName)
- After Phase 7 deploys, update `infra/compute/index.ts` to switch from `getOutput()` to `requireOutput()`

### Claude's Discretion

- NAT gateway count: 2 (match CDK). Can reduce to 1 before cutover if cost is a concern.

### Deferred Ideas (OUT OF SCOPE)

None surfaced during discussion.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PULUMI-02 | Deploy NetworkingStack via Pulumi: VPC, 4-tier subnets, NAT gateway, IGW, VPC Gateway Endpoints (S3 + DynamoDB), RDS/ElastiCache subnet groups | awsx.ec2.Vpc handles VPC+subnets+NAT+IGW; raw aws.ec2.VpcEndpoint for gateway endpoints; aws.rds.SubnetGroup + aws.elasticache.SubnetGroup for subnet groups |
| PULUMI-03 | ComputeStack reads VPC ID and subnet IDs from NetworkingStack via StackReference.requireOutput() — no hardcoded IDs | Switch from getOutput() to requireOutput() in infra/compute/index.ts after Phase 7 deploys real outputs |
</phase_requirements>

---

## Summary

Phase 7 replaces the scaffold placeholder in `infra/networking/index.ts` with real AWS resources using the `@pulumi/awsx` `Vpc` component. The component handles VPC, subnets, route tables, NAT gateways, EIPs, and IGW automatically — significantly less code than raw primitives.

The critical finding is that `awsx.ec2.Vpc` merges all `Isolated` subnet specs into a single `isolatedSubnetIds` output. Since both Database (/24) and Intra (/26) tiers use `type: "Isolated"`, the component cannot distinguish them in its outputs. The solution is to use `vpc.subnets` filtered by CIDR prefix to separate database vs intra subnet IDs for the stack exports.

VPC Gateway Endpoints are NOT handled by the awsx Vpc component — they require raw `aws.ec2.VpcEndpoint` resources. Route table IDs for the endpoint associations must be extracted from `vpc.routeTables` by correlating with known subnet IDs.

**Primary recommendation:** Use `awsx.ec2.Vpc` with `subnetSpecs` + explicit `cidrBlocks`, filter `vpc.subnets` by CIDR to separate database/intra tiers, and add raw `aws.ec2.VpcEndpoint` resources for S3 and DynamoDB gateway endpoints.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@pulumi/awsx` | `3.3.1` | High-level Vpc component — handles VPC, subnets, route tables, NAT, IGW | User-locked decision; equivalent to CDK's ec2.Vpc with subnetConfiguration |
| `@pulumi/aws` | `7.23.0` | Raw AWS resources — VpcEndpoint, rds.SubnetGroup, elasticache.SubnetGroup | Already in package.json; needed for resources awsx doesn't cover |
| `@pulumi/pulumi` | `3.228.0` | Core SDK — Config, Output, StackReference | Already in package.json |

**Version verification:** All versions confirmed from npm registry 2026-03-29.

**Installation — add @pulumi/awsx to infra/networking/package.json:**
```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pulumi-migration/infra/networking
npm install @pulumi/awsx@^3.3.1
```

---

## Architecture Patterns

### Recommended Project Structure

```
infra/networking/
├── index.ts          # All networking resources (VPC, endpoints, subnet groups, exports)
├── package.json      # Add @pulumi/awsx@^3.3.1
├── Pulumi.yaml       # Project definition
├── Pulumi.prod.yaml  # Add vpcCidr, maxAzs, natGateways config keys
└── tsconfig.json     # Unchanged
```

No sub-modules needed — networking is small enough for a single `index.ts`.

### Pattern 1: awsx.ec2.Vpc with Explicit CIDRs

**What:** Use `subnetSpecs` with `cidrBlocks` arrays to pin exact CIDRs per AZ. This matches CDK's deterministic allocation and avoids drift if the component's auto-allocation algorithm changes.

**When to use:** Always — explicit CIDRs are required for CDK parity and for the planner to document exact values in `Pulumi.prod.yaml`.

```typescript
// Source: https://www.pulumi.com/registry/packages/awsx/api-docs/ec2/vpc/
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const vpcCidr = config.get("vpcCidr") ?? "10.0.0.0/16";

const vpc = new awsx.ec2.Vpc("nucleus-vpc", {
    cidrBlock: vpcCidr,
    availabilityZoneNames: ["us-east-1a", "us-east-1b"],
    enableDnsHostnames: true,
    enableDnsSupport: true,
    natGateways: { strategy: "OnePerAz" },
    subnetSpecs: [
        {
            type: "Public",
            name: "public",
            cidrBlocks: ["10.0.8.0/24", "10.0.9.0/24"],
        },
        {
            type: "Private",
            name: "private",
            cidrBlocks: ["10.0.0.0/22", "10.0.4.0/22"],
        },
        {
            type: "Isolated",
            name: "database",
            cidrBlocks: ["10.0.10.0/24", "10.0.11.0/24"],
        },
        {
            type: "Isolated",
            name: "intra",
            cidrBlocks: ["10.0.12.0/26", "10.0.12.64/26"],
        },
    ],
});
```

### Pattern 2: Separating Database vs Intra Subnet IDs

**What:** `vpc.isolatedSubnetIds` returns ALL isolated subnets combined (4 total: 2 database + 2 intra). Filter `vpc.subnets` by CIDR prefix to get per-tier IDs.

**Why:** The awsx Vpc component has no per-spec output — it only exposes `publicSubnetIds`, `privateSubnetIds`, and `isolatedSubnetIds`. With two `Isolated` specs, both tiers are merged.

```typescript
// Source: awsx docs — isolatedSubnetIds combines all Isolated specs
// Filter by known CIDR prefix to separate tiers
const databaseSubnetIds = pulumi.output(vpc.subnets).apply(subnets =>
    subnets
        .filter(s => s.cidrBlock.apply(c => c?.startsWith("10.0.10.") || c?.startsWith("10.0.11.")))
        .map(s => s.id)
);

// Alternative: filter by subnet name (awsx names them "nucleus-vpc-database-0", "nucleus-vpc-database-1")
const databaseSubnetIds2 = pulumi.output(vpc.subnets).apply(subnets =>
    subnets
        .filter(s => s.tags.apply(t => t?.["Name"]?.includes("-database-")))
        .map(s => s.id)
);

const intraSubnetIds = pulumi.output(vpc.subnets).apply(subnets =>
    subnets
        .filter(s => s.tags.apply(t => t?.["Name"]?.includes("-intra-")))
        .map(s => s.id)
);
```

**Recommended approach:** Filter by subnet name tag (more robust than CIDR string matching). awsx names subnets as `<component-name>-<spec-name>-<index>`, so `nucleus-vpc-database-0`, `nucleus-vpc-database-1`, `nucleus-vpc-intra-0`, `nucleus-vpc-intra-1`.

### Pattern 3: VPC Gateway Endpoints (raw aws.ec2.VpcEndpoint)

**What:** awsx Vpc does NOT have an `addGatewayEndpoint` method. Use raw `aws.ec2.VpcEndpoint` with `routeTableIds` from the VPC's route tables.

**Route table IDs:** Use `aws.ec2.getRouteTableOutput({ subnetId })` to look up the route table for each subnet, then collect unique IDs.

```typescript
// Source: https://www.pulumi.com/registry/packages/aws/api-docs/ec2/vpcendpoint/
import * as aws from "@pulumi/aws";

// Get route table IDs for private + database + intra subnets
// awsx exposes vpc.routeTables — filter by association to target subnets
const privateAndIsolatedRouteTableIds = pulumi.all([
    vpc.privateSubnetIds,
    databaseSubnetIds,
    intraSubnetIds,
]).apply(([privateIds, dbIds, intraIds]) => {
    const allSubnetIds = [...privateIds, ...dbIds, ...intraIds];
    return allSubnetIds.map(subnetId =>
        aws.ec2.getRouteTableOutput({ subnetId }).routeTableId
    );
});

// Deduplicate (private subnets share route tables per AZ)
const uniqueRouteTableIds = privateAndIsolatedRouteTableIds.apply(ids =>
    [...new Set(ids)]
);

const region = aws.config.region ?? "us-east-1";

const s3Endpoint = new aws.ec2.VpcEndpoint("nucleus-endpoint-s3", {
    vpcId: vpc.vpcId,
    serviceName: pulumi.interpolate`com.amazonaws.${region}.s3`,
    vpcEndpointType: "Gateway",
    routeTableIds: uniqueRouteTableIds,
    tags: { Name: "nucleus-endpoint-s3" },
});

const dynamoEndpoint = new aws.ec2.VpcEndpoint("nucleus-endpoint-dynamodb", {
    vpcId: vpc.vpcId,
    serviceName: pulumi.interpolate`com.amazonaws.${region}.dynamodb`,
    vpcEndpointType: "Gateway",
    routeTableIds: uniqueRouteTableIds,
    tags: { Name: "nucleus-endpoint-dynamodb" },
});
```

### Pattern 4: RDS and ElastiCache Subnet Groups

```typescript
// Source: https://www.pulumi.com/registry/packages/aws/api-docs/rds/subnetgroup/
const dbSubnetGroup = new aws.rds.SubnetGroup("nucleus-db-subnet-group", {
    name: "nucleus-db-subnet-group",
    description: "Subnet group for RDS databases",
    subnetIds: databaseSubnetIds,
    tags: { Name: "nucleus-db-subnet-group" },
});

// Source: https://www.pulumi.com/registry/packages/aws/api-docs/elasticache/subnetgroup/
const cacheSubnetGroup = new aws.elasticache.SubnetGroup("nucleus-cache-subnet-group", {
    name: "nucleus-cache-subnet-group",
    description: "Subnet group for ElastiCache clusters",
    subnetIds: databaseSubnetIds,
});
```

### Pattern 5: Stack Exports

```typescript
// Export all outputs — match CDK CfnOutput keys exactly
export const vpcId = vpc.vpcId;
export const vpcCidr = vpc.vpc.cidrBlock;
export const publicSubnetIds = vpc.publicSubnetIds;
export const privateSubnetIds = vpc.privateSubnetIds;
export const databaseSubnetIds = databaseSubnetIds;
export const intraSubnetIds = intraSubnetIds;
export const availabilityZones = pulumi.output(["us-east-1a", "us-east-1b"]);
export const dbSubnetGroupName = dbSubnetGroup.name;
export const cacheSubnetGroupName = cacheSubnetGroup.name;
```

### Pattern 6: StackReference Update in Compute

After Phase 7 deploys real outputs, update `infra/compute/index.ts`:

```typescript
// Before (scaffold — getOutput returns undefined if stack not deployed):
const vpcId = networking.getOutput("vpcId");

// After (Phase 7 — requireOutput throws if networking not deployed):
const vpcId = networking.requireOutput("vpcId") as pulumi.Output<string>;
const privateSubnetIds = networking.requireOutput("privateSubnetIds") as pulumi.Output<string[]>;
const publicSubnetIds = networking.requireOutput("publicSubnetIds") as pulumi.Output<string[]>;
const databaseSubnetIds = networking.requireOutput("databaseSubnetIds") as pulumi.Output<string[]>;
const intraSubnetIds = networking.requireOutput("intraSubnetIds") as pulumi.Output<string[]>;
```

### Anti-Patterns to Avoid

- **Using `vpc.isolatedSubnetIds` directly for database or intra exports:** Returns all 4 isolated subnets merged — downstream consumers can't distinguish tiers.
- **Hardcoding service names:** Use `pulumi.interpolate` with `aws.config.region` so the endpoint works in any region.
- **Omitting `name` on subnet groups:** Without explicit `name`, Pulumi auto-names them with a 7-char suffix — breaks any existing RDS/ElastiCache clusters that reference the group by name.
- **Using `subnetStrategy: "Auto"` without `cidrBlocks`:** Auto-allocation is non-deterministic across Pulumi versions; always pin CIDRs explicitly.

---

## Calculated Subnet CIDRs

CDK allocates subnets sorted by cidrMask ascending (largest subnet first), sequentially from VPC base address. For `10.0.0.0/16` with 2 AZs:

| Tier | AZ | CIDR | Mask |
|------|----|------|------|
| Private | us-east-1a | `10.0.0.0/22` | /22 |
| Private | us-east-1b | `10.0.4.0/22` | /22 |
| Public | us-east-1a | `10.0.8.0/24` | /24 |
| Public | us-east-1b | `10.0.9.0/24` | /24 |
| Database | us-east-1a | `10.0.10.0/24` | /24 |
| Database | us-east-1b | `10.0.11.0/24` | /24 |
| Intra | us-east-1a | `10.0.12.0/26` | /26 |
| Intra | us-east-1b | `10.0.12.64/26` | /26 |

**Confidence:** HIGH — calculated via deterministic algorithm matching CDK's `cidrMask` allocation (verified by running the allocation logic directly).

These values go into `Pulumi.prod.yaml` and are referenced in `subnetSpecs[].cidrBlocks`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| VPC + subnets + route tables + NAT + IGW | Manual aws.ec2.* resources for each | `awsx.ec2.Vpc` | ~150 lines of raw resources vs ~30 lines; handles route table associations, EIP allocation, IGW attachment automatically |
| Subnet CIDR allocation | Custom CIDR math in TypeScript | Pre-calculated values in Pulumi.prod.yaml | Deterministic, reviewable, no runtime math |
| Route table lookup for endpoints | Custom DynamoDB/SSM lookup | `aws.ec2.getRouteTableOutput({ subnetId })` | Built-in data source, no extra infrastructure |

---

## Common Pitfalls

### Pitfall 1: isolatedSubnetIds Merges All Isolated Tiers

**What goes wrong:** Exporting `vpc.isolatedSubnetIds` directly as `databaseSubnetIds` includes both Database and Intra subnets (4 IDs instead of 2). The RDS subnet group gets created with intra subnets included, which is wrong.

**Why it happens:** awsx Vpc has no per-spec output — `isolatedSubnetIds` is a flat list of all subnets with `type: "Isolated"`.

**How to avoid:** Filter `vpc.subnets` by the `Name` tag (awsx sets `Name` to `<component>-<spec-name>-<index>`). Database subnets will be tagged `nucleus-vpc-database-0` and `nucleus-vpc-database-1`.

**Warning signs:** `databaseSubnetIds` output has 4 elements instead of 2.

### Pitfall 2: Output<string[]> vs string[] in routeTableIds

**What goes wrong:** `aws.ec2.VpcEndpoint` expects `routeTableIds: pulumi.Input<string[]>`. If you pass an `Output<Output<string>[]>` (array of outputs), TypeScript accepts it but Pulumi may not resolve correctly.

**Why it happens:** `vpc.subnets` is `Output<Subnet[]>`, and mapping over it produces nested outputs.

**How to avoid:** Use `pulumi.all([...]).apply(...)` to flatten all outputs into a single `Output<string[]>` before passing to `routeTableIds`.

### Pitfall 3: Pulumi.prod.yaml Missing Config Keys

**What goes wrong:** `new pulumi.Config().get("vpcCidr")` returns `undefined` if the key isn't in `Pulumi.prod.yaml`. The VPC gets created with the default `10.0.0.0/16` — which is correct here — but `maxAzs` and `natGateways` silently use defaults (3 AZs, 1 NAT) instead of the intended values.

**How to avoid:** Add all three keys to `Pulumi.prod.yaml` before running `pulumi up`. The planner must include this as a task.

### Pitfall 4: awsx Subnet Name Tag Format

**What goes wrong:** Filtering `vpc.subnets` by `Name` tag assumes awsx uses `<component>-<spec-name>-<index>` format. If the format changes between awsx versions, the filter silently returns empty arrays.

**How to avoid:** After `pulumi up`, verify subnet IDs with `pulumi stack output databaseSubnetIds` and cross-check against AWS console. Add a sanity check: if `databaseSubnetIds.length !== 2`, fail loudly.

### Pitfall 5: StackReference requireOutput Before Networking Deployed

**What goes wrong:** Switching `infra/compute/index.ts` to `requireOutput()` before Phase 7 `pulumi up` completes causes `pulumi preview` on compute to throw: `"Required output 'vpcId' does not exist on stack"`.

**How to avoid:** The compute `requireOutput()` update is the LAST task in Phase 7 — after `pulumi up` in networking succeeds and outputs are verified.

---

## Pulumi.prod.yaml Config to Add

```yaml
config:
  aws:region: us-east-1
  nucleus-networking:vpcCidr: 10.0.0.0/16
  nucleus-networking:maxAzs: 2
  nucleus-networking:natGateways: 2
secretsprovider: awskms://alias/pulumi-secrets?region=us-east-1
encryptedkey: AQICAHgKGeti15Vdcfk9By77gHbFq3IykDNyF5lB23hWk4E3nQGZPb3YFVmGwYfXhmYCIogUAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQM3q79UZMo415iyrVXAgEQgDvgzZCThXGS+TsjX+PE3IoWScqXxAZJ5gMYdjpM7TIWkELbllq+jEW+2RllFKlTnOKfVbPsRPF1Asq/dA==
```

(The `secretsprovider` and `encryptedkey` lines already exist — preserve them. Add the three `nucleus-networking:*` config keys.)

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Pulumi CLI | `pulumi up` | ✓ | v3.202.0 | — |
| Node.js | Pulumi TypeScript runtime | ✓ | v20.19.6 | — |
| npm | Package install | ✓ | 10.8.2 | — |
| AWS CLI / profile `PLATFORM-ADMIN` | `pulumi up` AWS auth | assumed ✓ | — | Set `AWS_PROFILE=PLATFORM-ADMIN` |
| `@pulumi/awsx` | Vpc component | not yet installed | 3.3.1 (latest) | — |

**Missing dependencies with no fallback:**
- `@pulumi/awsx` must be added to `infra/networking/package.json` and `npm install` run before `pulumi up`.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Raw `aws.ec2.Vpc` + manual subnets/route tables | `awsx.ec2.Vpc` component | awsx v2+ | ~80% less networking code |
| `subnetStrategy: "Legacy"` (default) | `subnetSpecs` with explicit `cidrBlocks` | awsx v2 | Deterministic, reviewable CIDRs |
| `natGateways: { strategy: "Single" }` | `natGateways: { strategy: "OnePerAz" }` | awsx v2 | HA during migration |

**Note:** Prior research (STACK.md) listed `@pulumi/awsx` under "What NOT to Add" based on the original decision to use raw primitives. The CONTEXT.md overrides this — the user explicitly chose awsx for Phase 7. The STACK.md recommendation was for CDK parity verification; awsx is now the locked choice.

---

## Open Questions

1. **awsx subnet Name tag format**
   - What we know: awsx names subnets as `<component>-<spec-name>-<index>` based on docs
   - What's unclear: Whether the `Name` tag uses the `name` property from `SubnetSpec` or the `type` field
   - Recommendation: After `pulumi preview`, inspect the planned subnet `Name` tags in the diff output before `pulumi up`. Adjust filter logic if needed.

2. **Route table deduplication for VPC endpoints**
   - What we know: Private subnets in the same AZ share a route table; isolated subnets may share one too
   - What's unclear: Whether awsx creates one route table per subnet or one per tier per AZ
   - Recommendation: Use `[...new Set(ids)]` to deduplicate route table IDs before passing to `routeTableIds`. Extra IDs are harmless; missing IDs break endpoint routing.

---

## Sources

### Primary (HIGH confidence)
- `https://www.pulumi.com/registry/packages/awsx/api-docs/ec2/vpc/` — awsx.ec2.Vpc constructor, VpcArgs, SubnetSpec, NatGatewayConfiguration, output properties
- `https://www.pulumi.com/registry/packages/awsx/api-docs/ec2/vpc/#subnetspec` — SubnetSpec cidrBlocks, isolatedSubnetIds behavior with multiple Isolated specs
- `https://www.pulumi.com/registry/packages/aws/api-docs/ec2/vpcendpoint/` — aws.ec2.VpcEndpoint gateway type, serviceName format, routeTableIds
- `https://www.pulumi.com/registry/packages/aws/api-docs/rds/subnetgroup/` — aws.rds.SubnetGroup args
- `https://www.pulumi.com/registry/packages/aws/api-docs/elasticache/subnetgroup/` — aws.elasticache.SubnetGroup args
- `https://www.pulumi.com/registry/packages/aws/api-docs/ec2/getroutetable/` — aws.ec2.getRouteTableOutput by subnetId
- npm registry — @pulumi/awsx@3.3.1, @pulumi/aws@7.23.0, @pulumi/pulumi@3.228.0 (verified 2026-03-29)
- CDK CIDR allocation algorithm — calculated directly from CDK source behavior (HIGH — deterministic math)

### Secondary (MEDIUM confidence)
- awsx subnet Name tag format (`<component>-<spec-name>-<index>`) — inferred from awsx docs + training data; verify after `pulumi preview`

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions verified from npm registry
- awsx Vpc API: HIGH — verified from official Pulumi registry docs
- Subnet CIDR calculation: HIGH — deterministic algorithm, verified by running the math
- isolatedSubnetIds merging behavior: HIGH — explicitly documented in awsx SubnetSpec docs
- Subnet Name tag format for filtering: MEDIUM — inferred from docs, verify after preview
- Route table deduplication: MEDIUM — standard pattern, exact awsx behavior unverified

**Research date:** 2026-03-29
**Valid until:** 2026-04-29 (awsx is actively developed; re-verify if version bumps past 3.3.x)

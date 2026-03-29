---
phase: 07-networking
created: 2026-03-29
status: ready
---

# Phase 7: Networking — Context

## Domain

Deploy a new VPC with 4-tier subnets, NAT gateway, VPC endpoints, and subnet groups via Pulumi.
Exports stable stack outputs (vpcId, subnetIds) for compute to consume via StackReference.

This is a direct CDK → Pulumi translation of `lib/networkingStack.ts`. CDK networking stays live
throughout this phase — Pulumi creates a parallel new VPC (blue/green).

## Canonical Refs

- `lib/networkingStack.ts` — CDK source of truth for all resource configs (CIDR, AZs, subnet tiers, endpoints, subnet groups, outputs)
- `.planning/research/ARCHITECTURE.md` — StackReference format, Pulumi config pattern, anti-patterns
- `.planning/research/PITFALLS.md` — Explicit physical names, forceNewDeployment, passphrase loss
- `.planning/research/STACK.md` — Package versions, tsconfig pattern
- `infra/networking/index.ts` — Scaffold placeholder to replace with real resources
- `infra/networking/Pulumi.prod.yaml` — Stack config (add vpcCidr, maxAzs, natGateways here)

## Decisions

### Resource Naming Strategy — LOCKED

**Decision:** Drop the `-app` suffix. Use `nucleus-*` prefix for all Pulumi networking resources.

**Rationale:** CDK names everything `nucleus-app-*` (from APP_NAME env var). Pulumi uses `nucleus-*`.
No naming conflict during coexistence. These become the permanent names — no rename needed at cutover.

**Naming pattern:**
- VPC: `nucleus-vpc`
- Subnets: `nucleus-subnet-public-{az}`, `nucleus-subnet-private-{az}`, `nucleus-subnet-database-{az}`, `nucleus-subnet-intra-{az}`
- IGW: `nucleus-igw`
- NAT EIPs: `nucleus-eip-nat-{az}`
- NAT Gateways: `nucleus-nat-{az}`
- Route tables: `nucleus-rt-public`, `nucleus-rt-private-{az}`, `nucleus-rt-database`, `nucleus-rt-intra`
- VPC Endpoints: `nucleus-endpoint-s3`, `nucleus-endpoint-dynamodb`
- RDS Subnet Group: `nucleus-db-subnet-group`
- ElastiCache Subnet Group: `nucleus-cache-subnet-group`

All names must be set as explicit `name:` properties — never rely on Pulumi auto-naming (7-char suffix causes delete+create on rename).

### NAT Gateway Count — Claude's Discretion

Match CDK: 2 NAT gateways (one per AZ). HA during migration period. Can be reduced to 1 before cutover if cost is a concern.

### VPC Configuration — Match CDK Exactly

From `lib/networkingStack.ts` + `.env.example`:
- CIDR: `10.0.0.0/16`
- AZs: 2 (`us-east-1a`, `us-east-1b`)
- DNS hostnames: enabled
- DNS support: enabled
- Default SG: restricted
- IGW: created

### Subnet Tiers — Match CDK Exactly

4-tier architecture from CDK source:

| Tier | Name | Type | CIDR mask | Count |
|------|------|------|-----------|-------|
| 1 | Public | Public (with IGW route) | /24 | 2 (one per AZ) |
| 2 | Private | Private with egress (NAT route) | /22 | 2 (one per AZ) |
| 3 | Database | Isolated (no egress) | /24 | 2 (one per AZ) |
| 4 | Intra | Isolated (no egress) | /26 | 2 (one per AZ) |

**Explicit CIDRs:** Pulumi requires explicit CIDRs (unlike CDK's cidrMask auto-allocation).
The planner must calculate these from CDK's allocation pattern and put them in `Pulumi.prod.yaml`.
CDK allocates in order: Public → Private → Database → Intra, aligned to subnet mask boundaries.

### VPC Endpoints — Match CDK Exactly

Gateway endpoints only (free tier):
- S3 Gateway Endpoint — routes from Private, Database, Intra subnets
- DynamoDB Gateway Endpoint — routes from Private, Database, Intra subnets

No Interface endpoints (these cost ~$7/month each and CDK doesn't have them).

### Subnet Groups — Match CDK Exactly

- RDS DB Subnet Group: `nucleus-db-subnet-group` — uses Database tier subnets
- ElastiCache Subnet Group: `nucleus-cache-subnet-group` — uses Database tier subnets

### Stack Outputs — Match CDK CfnOutputs Exactly

Export the same keys CDK exports (compute StackReference will use these):
- `vpcId` — VPC ID
- `vpcCidr` — VPC CIDR block
- `publicSubnetIds` — array of public subnet IDs
- `privateSubnetIds` — array of private subnet IDs
- `databaseSubnetIds` — array of database subnet IDs
- `intraSubnetIds` — array of intra subnet IDs
- `availabilityZones` — array of AZ names
- `dbSubnetGroupName` — RDS subnet group name
- `cacheSubnetGroupName` — ElastiCache subnet group name

### StackReference in Compute — Update to requireOutput()

After Phase 7 deploys real networking outputs, update `infra/compute/index.ts` to switch from
`getOutput()` (scaffold placeholder) to `requireOutput()` — this enforces that networking must
be deployed before compute can preview/deploy.

### Pulumi Config Pattern

Add to `infra/networking/Pulumi.prod.yaml`:
```yaml
config:
  aws:region: us-east-1
  nucleus-networking:vpcCidr: 10.0.0.0/16
  nucleus-networking:maxAzs: 2
  nucleus-networking:natGateways: 2
```

Read in `index.ts` via `new pulumi.Config()`.

### Route Tables

CDK's `ec2.Vpc` auto-creates route tables. Pulumi requires explicit route table resources:
- 1 public route table (shared across public subnets) — route 0.0.0.0/0 → IGW
- 2 private route tables (one per AZ) — route 0.0.0.0/0 → NAT gateway in same AZ
- 1 database route table (isolated — no default route)
- 1 intra route table (isolated — no default route)

Each subnet needs a `aws.ec2.RouteTableAssociation`.

## Deferred Ideas

None surfaced during discussion.

## What Downstream Agents Should Know

- **Researcher:** Investigate `aws.ec2.Vpc`, `aws.ec2.Subnet`, `aws.ec2.NatGateway`, `aws.ec2.Eip`, `aws.ec2.InternetGateway`, `aws.ec2.RouteTable`, `aws.ec2.Route`, `aws.ec2.RouteTableAssociation`, `aws.ec2.VpcEndpoint` (gateway type), `aws.rds.SubnetGroup`, `aws.elasticache.SubnetGroup` in `@pulumi/aws`. Verify exact property names — CDK abstracts many of these.
- **Planner:** Calculate explicit subnet CIDRs from CDK's allocation pattern. Put them in `Pulumi.prod.yaml`. The plan must include a `pulumi up` task (not just preview) — Phase 7 success requires real deployed resources.
- **Executor:** This phase deploys real AWS resources. `pulumi up` will create ~25+ resources. Estimated cost: ~$130/month for 2 NAT gateways (EIPs + NAT). CDK networking stays live — no conflict.

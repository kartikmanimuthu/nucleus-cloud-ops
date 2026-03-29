# Architecture Patterns: Pulumi TypeScript IaC Migration

**Domain:** CDK → Pulumi migration for AWS Cloud Ops platform
**Researched:** 2026-03-29
**Overall confidence:** HIGH (Pulumi docs verified via official sources)

---

## Recommended Architecture

### Directory Layout

Place the Pulumi project in a new top-level `infra/` directory — not at the repo root. Reasons:

1. CDK uses `"module": "commonjs"` in `tsconfig.json`; Pulumi TypeScript uses `"module": "ESNext"` — they conflict if co-located
2. CDK's `cdk.json` and `Pulumi.yaml` both expect to be the root config file for their respective tools
3. Keeping `infra/` separate makes the coexistence period clean: CDK files in `lib/` + `bin/`, Pulumi files in `infra/`
4. After migration, `lib/networkingStack.ts` and `lib/computeStack.ts` are deleted; `infra/` remains

Two Pulumi **projects** mirror the two CDK stacks. In Pulumi, a project = one `Pulumi.yaml` + program. A stack = one deployment instance of that project (e.g., `prod`).

```
infra/
  networking/                  # Pulumi project 1 — mirrors NetworkingStack
    Pulumi.yaml
    index.ts
    package.json
    tsconfig.json
    Pulumi.prod.yaml            # stack-specific config (region, CIDR, etc.)
  compute/                     # Pulumi project 2 — mirrors ComputeStack
    Pulumi.yaml
    index.ts
    components/                # optional: split large index.ts into modules
      dynamodb.ts
      ecs.ts
      lambda.ts
      cognito.ts
      cloudfront.ts
    package.json
    tsconfig.json
    Pulumi.prod.yaml
  bootstrap/                   # one-time setup — creates S3 bucket for state
    bootstrap.sh                # aws cli commands to create bucket + enable versioning
```

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `infra/networking/` | VPC, subnets (4 tiers), NAT gateway, VPC endpoints, RDS/cache subnet groups | Exports outputs consumed by compute |
| `infra/compute/` | ECS Fargate, ALB, CloudFront, all Lambda functions, DynamoDB tables, SQS, EventBridge, Cognito, S3 buckets | Reads networking outputs via StackReference |
| `infra/bootstrap/` | S3 state bucket creation (one-time, manual) | Prerequisite for both projects |
| `lib/webUIStack.ts` | Stays in CDK — not migrated | Independent CDK stack |
| `web-ui/` | Reads Pulumi stack outputs as env vars | Downstream consumer |

---

## S3 Backend Bootstrap Process

Pulumi's S3 backend does **not** require DynamoDB. Unlike Terraform, Pulumi handles state locking internally using S3 conditional writes (optimistic locking). You only need an S3 bucket with versioning enabled.

### Bootstrap Steps (one-time, manual)

```bash
# 1. Create the state bucket (versioning required for Pulumi's locking)
aws s3api create-bucket \
  --bucket nucleus-pulumi-state \
  --region us-east-1 \
  --profile PLATFORM-ADMIN

aws s3api put-bucket-versioning \
  --bucket nucleus-pulumi-state \
  --versioning-configuration Status=Enabled \
  --profile PLATFORM-ADMIN

# 2. Block public access
aws s3api put-public-access-block \
  --bucket nucleus-pulumi-state \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  --profile PLATFORM-ADMIN

# 3. Login to the S3 backend (run once per machine/CI environment)
pulumi login 's3://nucleus-pulumi-state?region=us-east-1&awssdk=v2&profile=PLATFORM-ADMIN'
```

The `bootstrap/bootstrap.sh` script in `infra/bootstrap/` captures these commands so they're reproducible.

### Pulumi.yaml Backend Config (alternative to CLI login)

```yaml
name: nucleus-networking
runtime: nodejs
description: Nucleus Cloud Ops — VPC and networking
backend:
  url: s3://nucleus-pulumi-state?region=us-east-1&awssdk=v2&profile=PLATFORM-ADMIN
```

Setting `backend.url` in `Pulumi.yaml` means no `pulumi login` step is needed — the project always uses this backend. This is the recommended approach for CI/CD.

---

## Cross-Stack References: CDK Props → Pulumi StackReference

### CDK Pattern (current)

```typescript
// bin/cdkStack.ts — passes vpc object directly as a prop
const networkingStack = new NetworkingStack(app, 'NetworkingStack', { ... });
new ComputeStack(app, 'ComputeStack', { vpc: networkingStack.vpc });
```

CDK resolves this at synth time within the same process. CloudFormation exports/imports handle the actual runtime dependency.

### Pulumi Pattern (target)

Pulumi uses `StackReference` — one project reads exported outputs from another project's deployed stack.

**Step 1: networking/index.ts exports outputs**

```typescript
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const vpc = new aws.ec2.Vpc("nucleus-vpc", { ... });

// Export IDs — these become the StackReference outputs
export const vpcId = vpc.id;
export const vpcCidr = vpc.cidrBlock;
export const publicSubnetIds = pulumi.output(publicSubnets.map(s => s.id));
export const privateSubnetIds = pulumi.output(privateSubnets.map(s => s.id));
export const databaseSubnetIds = pulumi.output(databaseSubnets.map(s => s.id));
export const intraSubnetIds = pulumi.output(intraSubnets.map(s => s.id));
```

**Step 2: compute/index.ts consumes via StackReference**

```typescript
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// Format: "organization/project-name/stack-name"
// With S3 backend (no org), format is: "organization/project/stack"
// For self-managed backends, use the project name directly
const networking = new pulumi.StackReference("nucleus-networking/prod");

const vpcId = networking.requireOutput("vpcId") as pulumi.Output<string>;
const privateSubnetIds = networking.requireOutput("privateSubnetIds") as pulumi.Output<string[]>;

// Reconstruct VPC object from ID (for resources that need the full object)
const vpc = aws.ec2.Vpc.get("nucleus-vpc", vpcId);

// Reconstruct subnet objects from IDs
const privateSubnets = privateSubnetIds.apply(ids =>
  ids.map((id, i) => aws.ec2.Subnet.get(`private-subnet-${i}`, id))
);
```

**StackReference name format with S3 backend:**

With a self-managed (S3) backend, the organization segment is omitted. The format is `<project>/<stack>`:

```typescript
const networking = new pulumi.StackReference("nucleus-networking/prod");
```

---

## Stack Outputs → web-ui Env Vars

### CDK Pattern (current)

CDK inlines env vars directly into the ECS task definition container environment at synth time. Values like `this.userPool.userPoolId` are resolved by CloudFormation at deploy time.

### Pulumi Pattern (target)

Pulumi stack outputs are available after `pulumi up` via CLI. The pattern is to generate a `.env` file from outputs:

```bash
# After pulumi up in infra/compute/
pulumi stack output --json --stack prod > /tmp/pulumi-outputs.json

# Script reads JSON and writes web-ui/.env.local
node scripts/generate-env.ts
```

**scripts/generate-env.ts** (new file to create):

```typescript
import { execSync } from "child_process";
import { writeFileSync } from "fs";

const outputs = JSON.parse(
  execSync("pulumi stack output --json --stack prod", {
    cwd: "infra/compute"
  }).toString()
);

const envLines = [
  `COGNITO_USER_POOL_ID=${outputs.cognitoUserPoolId}`,
  `COGNITO_USER_POOL_CLIENT_ID=${outputs.cognitoUserPoolClientId}`,
  `COGNITO_IDENTITY_POOL_ID=${outputs.cognitoIdentityPoolId}`,
  `APP_TABLE_NAME=${outputs.appTableName}`,
  `AUDIT_TABLE_NAME=${outputs.auditTableName}`,
  // ... all other env vars
];

writeFileSync("web-ui/.env.local", envLines.join("\n"));
```

For ECS container environment (the equivalent of CDK's inline env block), Pulumi passes outputs directly as `Output<string>` values — Pulumi resolves them at deploy time:

```typescript
const container = new aws.ecs.TaskDefinition("web-ui-task", {
  containerDefinitions: pulumi.all([
    userPool.id,
    userPoolClient.id,
    appTable.name,
  ]).apply(([poolId, clientId, tableName]) =>
    JSON.stringify([{
      name: "WebUIContainer",
      environment: [
        { name: "COGNITO_USER_POOL_ID", value: poolId },
        { name: "COGNITO_USER_POOL_CLIENT_ID", value: clientId },
        { name: "APP_TABLE_NAME", value: tableName },
        // ...
      ]
    }])
  )
});
```

---

## Patterns to Follow

### Pattern 1: pulumi.all() for multi-output dependencies

When a resource needs multiple Output values resolved together (e.g., the ECS container env block), use `pulumi.all()`:

```typescript
const containerDef = pulumi.all([
  userPool.id, userPoolClient.id, appTable.name, auditTable.name
]).apply(([poolId, clientId, appTableName, auditTableName]) => ({
  // all values are plain strings here
  environment: [
    { name: "COGNITO_USER_POOL_ID", value: poolId },
    ...
  ]
}));
```

### Pattern 2: ComponentResource for logical grouping

Split the large ComputeStack into ComponentResources — Pulumi's equivalent of CDK Constructs:

```typescript
// infra/compute/components/dynamodb.ts
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export class NucleusDynamoTables extends pulumi.ComponentResource {
  public readonly appTable: aws.dynamodb.Table;
  public readonly auditTable: aws.dynamodb.Table;
  // ...

  constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
    super("nucleus:compute:DynamoTables", name, {}, opts);
    this.appTable = new aws.dynamodb.Table("app-table", { ... }, { parent: this });
    // ...
  }
}
```

Then in `index.ts`:
```typescript
const tables = new NucleusDynamoTables("nucleus-tables");
const ecs = new NucleusEcsService("nucleus-ecs", { tables, vpc });
```

### Pattern 3: Config for environment-specific values

Replace CDK's `getConfig()` / env var reading with Pulumi's typed config:

```typescript
// infra/networking/index.ts
const config = new pulumi.Config();
const vpcCidr = config.get("vpcCidr") ?? "10.0.0.0/16";
const maxAzs = config.getNumber("maxAzs") ?? 2;
```

Values live in `Pulumi.prod.yaml`:
```yaml
config:
  aws:region: us-east-1
  nucleus-networking:vpcCidr: 10.0.0.0/16
  nucleus-networking:maxAzs: 2
  nucleus-networking:natGateways: 2
```

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Single Pulumi project for both networking + compute

**What:** Putting all resources in one `index.ts` / one `Pulumi.yaml`
**Why bad:** Loses independent deployability. Networking changes force a full compute plan. Mirrors the CDK problem of one giant stack.
**Instead:** Two separate projects with StackReference. Deploy networking first, compute second.

### Anti-Pattern 2: Hardcoding Output values with `.get()` before they exist

**What:** Calling `aws.ec2.Vpc.get("vpc", "vpc-hardcoded-id")` with a literal ID
**Why bad:** Breaks the dependency graph — Pulumi won't know to wait for networking to deploy first
**Instead:** Always pass `vpcId` as an `Output<string>` from StackReference; Pulumi resolves ordering automatically

### Anti-Pattern 3: Using `pulumi.output().apply()` for everything

**What:** Wrapping every value in `.apply()` unnecessarily
**Why bad:** Makes code hard to read; `.apply()` defers execution and hides values during preview
**Instead:** Use `pulumi.all()` only when you need multiple outputs resolved together; keep plain values plain

### Anti-Pattern 4: Deleting CDK stacks before Pulumi stacks are deployed

**What:** Running `cdk destroy NetworkingStack` before `pulumi up` in `infra/networking/`
**Why bad:** Destroys live infrastructure with no replacement
**Instead:** Deploy Pulumi stacks first, verify they're healthy, then destroy CDK stacks

---

## CDK/Pulumi Coexistence During Migration

During the migration phases, both CDK and Pulumi will exist in the repo simultaneously:

| Phase | CDK State | Pulumi State |
|-------|-----------|--------------|
| PULUMI-01 (scaffold) | NetworkingStack + ComputeStack active | infra/ exists, no resources deployed |
| PULUMI-02 (networking) | NetworkingStack active | infra/networking/ deployed to a NEW VPC |
| PULUMI-03–05 (compute) | ComputeStack active | infra/compute/ deployed alongside CDK compute |
| PULUMI-06 (cutover) | CDK stacks destroyed | Pulumi stacks are the only IaC |

Key constraint: Pulumi creates **new** AWS resources — it does not import the existing CDK-managed resources. The cutover is a blue/green switch at the DNS/CloudFront level, not an in-place migration.

---

## New Files Required

| File | Purpose |
|------|---------|
| `infra/bootstrap/bootstrap.sh` | One-time S3 state bucket creation |
| `infra/networking/Pulumi.yaml` | Networking project definition + backend URL |
| `infra/networking/index.ts` | VPC, subnets, NAT, endpoints, subnet groups |
| `infra/networking/package.json` | `@pulumi/pulumi`, `@pulumi/aws` dependencies |
| `infra/networking/tsconfig.json` | ESNext module, strict mode |
| `infra/networking/Pulumi.prod.yaml` | Stack config (CIDR, AZs, region) |
| `infra/compute/Pulumi.yaml` | Compute project definition + backend URL |
| `infra/compute/index.ts` | Entry point, wires components together |
| `infra/compute/components/dynamodb.ts` | All DynamoDB tables |
| `infra/compute/components/ecs.ts` | ECS cluster, task def, service, ALB |
| `infra/compute/components/lambda.ts` | Scheduler, vector processor, KB sync lambdas |
| `infra/compute/components/cognito.ts` | User pool, client, identity pool |
| `infra/compute/components/cloudfront.ts` | CloudFront distribution |
| `infra/compute/components/storage.ts` | S3 buckets, SQS queues, EventBridge |
| `infra/compute/package.json` | Dependencies |
| `infra/compute/tsconfig.json` | ESNext module, strict mode |
| `infra/compute/Pulumi.prod.yaml` | Stack config (app name, domain, ECS sizing) |
| `scripts/generate-env.ts` | Reads pulumi stack output → writes web-ui/.env.local |

## Modified Files

| File | Change |
|------|--------|
| `bin/cdkStack.ts` | Remove NetworkingStack + ComputeStack instantiation (PULUMI-06) |
| `lib/networkingStack.ts` | Delete (PULUMI-06) |
| `lib/computeStack.ts` | Delete (PULUMI-06) |
| `package.json` (root) | Remove CDK deps for deleted stacks (PULUMI-06) |
| `web-ui/.env.local.example` | Add note that values come from `scripts/generate-env.ts` |

---

## Build Order for Phases

1. **PULUMI-01: Scaffold** — `infra/bootstrap/`, `infra/networking/` and `infra/compute/` project files, S3 backend login, no AWS resources yet. Validates toolchain.

2. **PULUMI-02: Networking** — Deploy `infra/networking/` to AWS. Creates new VPC alongside existing CDK VPC. Exports vpcId, subnetIds. CDK networking still live.

3. **PULUMI-03: ECS** — Deploy ECS cluster, ALB, CloudFront in `infra/compute/` pointing at the Pulumi VPC. CDK compute still live.

4. **PULUMI-04: Lambda** — Add scheduler, vector processor, KB sync, discovery task definitions to `infra/compute/`.

5. **PULUMI-05: Data** — Add DynamoDB tables, SQS, EventBridge, Cognito, S3 buckets to `infra/compute/`. At this point Pulumi compute stack is feature-complete.

6. **PULUMI-06: Cutover** — Wire stack outputs to web-ui env vars. Destroy CDK NetworkingStack + ComputeStack. Remove CDK files.

---

## Scalability Considerations

| Concern | Approach |
|---------|----------|
| State file size | S3 backend handles large state files; versioning provides rollback |
| Concurrent deploys | Pulumi S3 locking prevents concurrent `pulumi up` on same stack |
| Secret values | Use `pulumi config set --secret` for NEXTAUTH_SECRET, Cognito client secret; stored encrypted in `Pulumi.prod.yaml` |
| Lambda bundling | Pulumi's `aws.lambda.Function` with `code: new pulumi.asset.AssetArchive(...)` or use `pulumi-aws-native` for NodejsFunction equivalent |

---

## Sources

- Pulumi project structure: https://www.pulumi.com/docs/iac/concepts/projects/ (HIGH confidence — official docs)
- Pulumi S3 backend config: https://www.pulumi.com/docs/iac/concepts/state-and-backends/ (HIGH confidence — official docs)
- StackReference API: https://www.pulumi.com/docs/iac/concepts/stacks/ (HIGH confidence — official docs)
- `aws.ec2.Vpc.get()` pattern: https://www.pulumi.com/registry/packages/aws/api-docs/ec2/vpc/ (HIGH confidence — official registry)
- Pulumi TypeScript project init: https://www.pulumi.com/docs/iac/get-started/aws/create-project/ (HIGH confidence — official docs)
- CDK/Pulumi coexistence pattern: training data + official docs (MEDIUM confidence — no single authoritative source for coexistence strategy)

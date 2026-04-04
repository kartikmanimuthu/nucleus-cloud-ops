---
phase: quick
plan: 260331-rpk
type: execute
wave: 1
depends_on: []
files_modified:
  - infra/compute/index.ts
  - infra/compute/Pulumi.prod.yaml
autonomous: true
requirements: [RDS-01]
must_haves:
  truths:
    - "RDS PostgreSQL instance exists in database-tier subnets"
    - "DATABASE_URL is available as an env var in WebUI ECS, Discovery ECS, Scheduler Lambda, VectorProcessor Lambda, KBSyncProcessor Lambda"
    - "postgresEndpoint and databaseUrl are exported as stack outputs"
  artifacts:
    - path: "infra/compute/index.ts"
      provides: "RDS SG, RDS instance, DATABASE_URL wired to all 5 services"
    - path: "infra/compute/Pulumi.prod.yaml"
      provides: "dbPassword config comment"
  key_links:
    - from: "rdsSecurityGroup"
      to: "postgresInstance"
      via: "vpcSecurityGroupIds"
    - from: "postgresInstance.address"
      to: "databaseUrl"
      via: "pulumi.interpolate"
    - from: "databaseUrl"
      to: "webUiTaskDef containerDefinitions"
      via: "pulumi.all([..., databaseUrl]).apply(...)"
---

<objective>
Add RDS PostgreSQL (postgres 16, db.t4g.micro) to the Pulumi compute stack and wire DATABASE_URL to all dependent services.

Purpose: The app code already uses Drizzle ORM expecting DATABASE_URL — this provisions the actual database and injects the connection string everywhere it's needed.
Output: RDS instance in database-tier subnets, DATABASE_URL in 5 service environments, stack outputs for endpoint + URL.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@infra/compute/index.ts
@infra/compute/Pulumi.prod.yaml
@infra/networking/index.ts

<interfaces>
<!-- Key variables already in infra/compute/index.ts that tasks must reference -->

From networking StackReference (lines 31-39):
  vpcId: pulumi.Output<string>
  vpcCidr: pulumi.Output<string>
  dbSubnetGroupName: pulumi.Output<string>   // "nucleus-db-subnet-group"

Security groups already defined:
  ecsServiceSecurityGroup  — aws.ec2.SecurityGroup (line 1480), id: pulumi.Output<string>
  discoverySecurityGroup   — aws.ec2.SecurityGroup (line 1075), id: pulumi.Output<string>

Config already loaded:
  const config = new pulumi.Config();
  const nextauthSecret = config.requireSecret("nextauthSecret");  // pattern to follow

WebUI task def containerDefinitions pattern (line 1343):
  pulumi.all([
    appTable.name, ..., nextauthSecret,   // add databaseUrl here
  ]).apply(([appTableN, ..., nextauthSecretVal, databaseUrlVal]) =>
    JSON.stringify([{ environment: [..., { name: "DATABASE_URL", value: databaseUrlVal }] }])
  )

Discovery task def containerDefinitions pattern (line 1101):
  pulumi.all([appTable.name, auditTable.name, inventoryBucket.bucket, discoveryLogGroup.name])
  .apply(([appTableN, auditTableN, inventoryBucketN, logGroupN]) => ...)
  // add databaseUrl to this array too

Scheduler Lambda env (line 642): plain object — pulumi.Input<string> values accepted
VectorProcessor Lambda env (line 795): plain object
KBSyncProcessor Lambda env (line 956): plain object

ECS task role: ecsTaskRole (line 1181) — add rds-db:connect inline policy
Scheduler Lambda role: schedulerLambdaRole (line ~560) — add rds-db:connect inline policy
VectorProcessor role: vectorProcessorRole (line 681) — add rds-db:connect inline policy
KBSyncProcessor role: kbSyncProcessorRole (line 833) — add rds-db:connect inline policy
Discovery task role: discoveryTaskRole (line 1003) — add rds-db:connect inline policy

Stack outputs section starts at line 1608.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add RDS security group, RDS instance, and DATABASE_URL secret</name>
  <files>infra/compute/index.ts</files>
  <action>
Insert a new section "RDS POSTGRESQL" after the existing SNS TOPIC section (around line 555) and before the SCHEDULER LAMBDA section. Add:

1. Read dbPassword secret from config:
```typescript
const dbPassword = config.requireSecret("dbPassword");
```
Add this near the top of the file alongside the other config.require* calls (after nextauthSecret on line 20).

2. RDS Security Group — place in the new RDS section:
```typescript
const rdsSecurityGroup = new aws.ec2.SecurityGroup("rds-sg", {
    name: "nucleus-cloud-ops-rds-sg",
    description: "Security group for RDS PostgreSQL - ECS and Lambda access",
    vpcId: vpcId,
    ingress: [
        {
            fromPort: 5432,
            toPort: 5432,
            protocol: "tcp",
            securityGroups: [ecsServiceSecurityGroup.id],
            description: "PostgreSQL from WebUI ECS tasks",
        },
        {
            fromPort: 5432,
            toPort: 5432,
            protocol: "tcp",
            securityGroups: [discoverySecurityGroup.id],
            description: "PostgreSQL from Discovery ECS tasks",
        },
        {
            fromPort: 5432,
            toPort: 5432,
            protocol: "tcp",
            cidrBlocks: [vpcCidr],
            description: "PostgreSQL from Lambda functions via VPC CIDR",
        },
    ],
    egress: [{
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
        description: "Allow all outbound",
    }],
});
```

IMPORTANT: `ecsServiceSecurityGroup` and `discoverySecurityGroup` are defined AFTER this section in the file. Move the RDS section to AFTER the ECS + ALB security groups section (after line ~1498, after `ecsServiceSecurityGroup` is defined). Place it between the ECS service SG definition and the ALB definition, or better: place the entire RDS section just before the STACK OUTPUTS section (around line 1608). This avoids forward-reference issues.

3. RDS Instance:
```typescript
const postgresInstance = new aws.rds.Instance("postgres", {
    identifier: "nucleus-cloud-ops-postgres",
    engine: "postgres",
    engineVersion: "16.3",
    instanceClass: "db.t4g.micro",
    dbName: "nucleus",
    username: "nucleus_admin",
    password: dbPassword,
    dbSubnetGroupName: dbSubnetGroupName,
    vpcSecurityGroupIds: [rdsSecurityGroup.id],
    multiAz: false,
    allocatedStorage: 20,
    storageType: "gp3",
    skipFinalSnapshot: true,
    deletionProtection: false,
    tags: { Name: "nucleus-cloud-ops-postgres" },
}, { retainOnDelete: false });
```

4. DATABASE_URL construction (secret-wrapped):
```typescript
const databaseUrl = pulumi.secret(
    pulumi.interpolate`postgresql://nucleus_admin:${dbPassword}@${postgresInstance.address}:5432/nucleus`
);
```
  </action>
  <verify>
    TypeScript compiles: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/database-migration/infra/compute && npx tsc --noEmit`
  </verify>
  <done>
    `postgresInstance`, `rdsSecurityGroup`, and `databaseUrl` are defined in index.ts with no TypeScript errors. `databaseUrl` is a `pulumi.Output&lt;string&gt;` wrapped in `pulumi.secret()`.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire DATABASE_URL to all services, add IAM, exports, and config comment</name>
  <files>infra/compute/index.ts, infra/compute/Pulumi.prod.yaml</files>
  <action>
**A. WebUI ECS task definition (line ~1343):**

Add `databaseUrl` to the `pulumi.all([...])` array and destructure it:
- Append `databaseUrl` as the last item in the `pulumi.all([...])` array (after `nextauthSecret`)
- Add `databaseUrlVal` as the last destructured variable in the `.apply(([..., nextauthSecretVal, databaseUrlVal]) => ...)`
- Add to the environment array: `{ name: "DATABASE_URL", value: databaseUrlVal }`

**B. Discovery ECS task definition (line ~1101):**

Add `databaseUrl` to the `pulumi.all([...])` array:
- Current: `pulumi.all([appTable.name, auditTable.name, inventoryBucket.bucket, discoveryLogGroup.name])`
- New: `pulumi.all([appTable.name, auditTable.name, inventoryBucket.bucket, discoveryLogGroup.name, databaseUrl])`
- Add `databaseUrlVal` to destructure: `.apply(([appTableN, auditTableN, inventoryBucketN, logGroupN, databaseUrlVal]) => ...)`
- Add to environment array: `{ name: "DATABASE_URL", value: databaseUrlVal }`

**C. Scheduler Lambda (line ~642):**

Add to the `variables` object:
```typescript
DATABASE_URL: databaseUrl,
```

**D. VectorProcessor Lambda (line ~795):**

Add to the `variables` object:
```typescript
DATABASE_URL: databaseUrl,
```

**E. KBSyncProcessor Lambda (line ~956):**

Add to the `variables` object:
```typescript
DATABASE_URL: databaseUrl,
```

**F. IAM — rds-db:connect for all roles:**

Add one inline policy per role. Use `postgresInstance.arn` for the resource:

```typescript
new aws.iam.RolePolicy("ecs-task-rds-connect-policy", {
    role: ecsTaskRole.id,
    policy: postgresInstance.arn.apply(rdsArn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["rds-db:connect"], Resource: [rdsArn] }],
    })),
});

new aws.iam.RolePolicy("discovery-task-rds-connect-policy", {
    role: discoveryTaskRole.id,
    policy: postgresInstance.arn.apply(rdsArn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["rds-db:connect"], Resource: [rdsArn] }],
    })),
});

new aws.iam.RolePolicy("scheduler-lambda-rds-connect-policy", {
    role: schedulerLambdaRole.id,
    policy: postgresInstance.arn.apply(rdsArn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["rds-db:connect"], Resource: [rdsArn] }],
    })),
});

new aws.iam.RolePolicy("vector-processor-rds-connect-policy", {
    role: vectorProcessorRole.id,
    policy: postgresInstance.arn.apply(rdsArn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["rds-db:connect"], Resource: [rdsArn] }],
    })),
});

new aws.iam.RolePolicy("kb-sync-processor-rds-connect-policy", {
    role: kbSyncProcessorRole.id,
    policy: postgresInstance.arn.apply(rdsArn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["rds-db:connect"], Resource: [rdsArn] }],
    })),
});
```

**G. Stack outputs (append to STACK OUTPUTS section):**

```typescript
// RDS PostgreSQL exports
export const postgresEndpoint = postgresInstance.address;
export const postgresPort = postgresInstance.port;
export const databaseUrl = pulumi.secret(databaseUrl);  // re-export as secret
```

Wait — `databaseUrl` is already declared as a const. Export it directly:
```typescript
export { databaseUrl };
export const postgresEndpoint = postgresInstance.address;
```

**H. Pulumi.prod.yaml — add dbPassword comment:**

Add this comment line after the existing `nextauthSecret` comment block:
```yaml
  # dbPassword: run: cd infra/compute && pulumi config set --secret dbPassword "your-password-here" --stack prod
```
  </action>
  <verify>
    TypeScript compiles: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/database-migration/infra/compute && npx tsc --noEmit`

    Grep confirms DATABASE_URL wired everywhere:
    `grep -n "DATABASE_URL" /Users/kartik/.superset/worktrees/nucleus-cloud-ops/database-migration/infra/compute/index.ts`
    Should show 5 matches (WebUI env, Discovery env, Scheduler Lambda, VectorProcessor Lambda, KBSyncProcessor Lambda).
  </verify>
  <done>
    - `DATABASE_URL` appears in all 5 service environments
    - 5 `rds-db:connect` IAM policies added (one per role)
    - `postgresEndpoint` and `databaseUrl` exported from stack
    - `Pulumi.prod.yaml` has dbPassword config comment
    - `npx tsc --noEmit` exits 0
  </done>
</task>

</tasks>

<verification>
```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/database-migration/infra/compute && npx tsc --noEmit
grep -c "DATABASE_URL" index.ts   # expect 5+
grep "postgresEndpoint\|databaseUrl" index.ts | grep "^export"
grep "dbPassword" Pulumi.prod.yaml
```
</verification>

<success_criteria>
- `npx tsc --noEmit` exits 0 in `infra/compute/`
- `grep -c "DATABASE_URL" infra/compute/index.ts` returns >= 5
- `postgresEndpoint` and `databaseUrl` are exported stack outputs
- `Pulumi.prod.yaml` contains a comment instructing how to set `dbPassword`
- Deployment: `cd infra/compute && pulumi config set --secret dbPassword "..." --stack prod && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod`
</success_criteria>

<output>
After completion, create `.planning/quick/260331-rpk-create-postgresql-rds-database-in-pulumi/260331-rpk-SUMMARY.md`
</output>

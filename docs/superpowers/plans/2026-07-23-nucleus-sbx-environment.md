# Nucleus Cloud Ops `sbx` Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a fully isolated sandbox environment (`appName: stx-nucleus-ops-sbx`, Pulumi stack `sbx`) in the same AWS account as prod (`970547372609` / `nucleus-deployment-non-prod`, `ap-south-1`), with zero shared or renamed AWS resources vs. prod, and zero impact on the running prod stack.

**Architecture:** Same Pulumi programs (`infra/networking`, `infra/compute`) already used for `prod`, run as a second stack. Every hardcoded `"nucleus-cloud-ops-*"` / `"nucleus-*"` resource name in both `index.ts` files is replaced with a config-driven `appName` interpolation, so `prod` and `sbx` can never collide on an AWS-level resource name. Two new `Pulumi.sbx.yaml` config files carry the sbx-specific values; `Pulumi.prod.yaml` is never touched. This is the exact pattern already proven in `/Users/H2702/.superset/projects/chatbot` (`prod`/`nonprod` stacks, one account).

**Tech Stack:** Pulumi (TypeScript), `@pulumi/aws`, `@pulumi/awsx`, AWS (VPC, RDS Postgres, ECS Fargate, ALB, CloudFront, Cognito, ECR, Secrets Manager, SNS), Bun.

## Global Constraints

- Same AWS account/profile as prod: `AWS_PROFILE=nucleus-deployment-non-prod` (account `970547372609`, region `ap-south-1`).
- Same Pulumi S3 state backend as prod (`s3://nucleus-pulumi-state`) and KMS secrets key — no bootstrap step needed, just new stacks.
- `Pulumi.prod.yaml` (both projects) must NOT be edited. Every new config key must default to prod's existing hardcoded value when unset, so prod's behavior is byte-for-byte unchanged.
- `appName = stx-nucleus-ops-sbx` for all sbx resource names. `dbName`/`dbUsername` cannot contain hyphens (Postgres identifier rule) — use `nucleus_sbx` / `nucleus_sbx_admin`, set explicitly via config (not derived from `appName`) so prod's default stays the literal `nucleus`/`nucleus_admin` it uses today.
- NAT strategy for sbx: `single` (1 EIP) — the account already has 17 EIPs allocated against a shown quota of 10; prod's `OnePerAz` (2 EIPs) stays the untouched default.
- Workers ECS `desiredCount` for sbx: `1` (prod stays default `2`). Web-ui `desiredCount` stays `1` for both (already matches).
- RDS `engineVersion` for sbx: `16.9` — AWS no longer offers `16.6` (what prod's live RDS runs) for new instances in `ap-south-1`; prod's default stays the literal `16.6` it runs today.
- No changes to `infra/cicd` — sbx is deployed manually via `pulumi up`, not through CodePipeline.
- Before any `sbx` deploy: `pulumi preview --stack prod` (both projects) must show **zero diff** after the code changes. If it doesn't, stop and fix the default before proceeding.

---

### Task 1: Parameterize `infra/networking/index.ts`

**Files:**
- Modify: `infra/networking/index.ts`

**Interfaces:**
- Produces: `appName` (string, config-driven, default `"nucleus-cloud-ops"`), used identically by Task 3's compute program via its own config (not shared code — each project reads its own `pulumi.Config()`).
- Config keys consumed: `nucleus-networking:appName` (string, optional), `nucleus-networking:natStrategy` (string, optional, `"single"` or unset).

- [ ] **Step 1: Add `appName` and `natStrategy` config reads**

At the top of `infra/networking/index.ts`, right after the existing `vpcCidrConfig` line (currently line 11):

```typescript
const appName = config.get("appName") ?? "nucleus-cloud-ops";
const natStrategy = config.get("natStrategy") === "single" ? "Single" : "OnePerAz";
```

- [ ] **Step 2: Replace the hardcoded `natGateways` strategy**

Change:
```typescript
    natGateways: { strategy: "OnePerAz" },
```
to:
```typescript
    natGateways: { strategy: natStrategy },
```

- [ ] **Step 3: Rename the VPC, S3 endpoint, and DB subnet group to `${appName}-*`**

Apply these exact replacements (each appears once):

| File location | Old | New |
|---|---|---|
| `new awsx.ec2.Vpc(...)` logical name | `"nucleus-vpc"` | `` `${appName}-vpc` `` |
| VPC `tags.Name` | `"nucleus-vpc"` | `` pulumi.interpolate`${appName}-vpc` `` |
| `new aws.ec2.VpcEndpoint(...)` logical name | `"nucleus-endpoint-s3"` | `` `${appName}-endpoint-s3` `` |
| VPC endpoint `tags.Name` | `"nucleus-endpoint-s3"` | `` pulumi.interpolate`${appName}-endpoint-s3` `` |
| `new aws.rds.SubnetGroup(...)` logical name | `"nucleus-db-subnet-group"` | `` `${appName}-db-subnet-group` `` |
| `dbSubnetGroup.name` (`name:` prop) | `"nucleus-db-subnet-group"` | `` pulumi.interpolate`${appName}-db-subnet-group` `` |
| `dbSubnetGroup.tags.Name` | `"nucleus-db-subnet-group"` | `` pulumi.interpolate`${appName}-db-subnet-group` `` |

Note: `tags.Name` values need `pulumi.interpolate` (or plain JS template literal, since `appName` is a plain `string`, not an `Output<string>` — a normal template literal `` `${appName}-vpc` `` works for all of these, `pulumi.interpolate` is only required for `Output<T>` values. Use plain template literals throughout this file since `appName` is a plain string.)

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd infra/networking && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add infra/networking/index.ts
git commit -m "feat(infra): parameterize networking stack by appName/natStrategy"
```

---

### Task 2: Deploy sbx networking stack

**Files:**
- Create: `infra/networking/Pulumi.sbx.yaml`

**Interfaces:**
- Consumes: Task 1's `appName`/`natStrategy` config keys.
- Produces: a live `sbx` networking stack whose outputs (`vpcId`, `vpcCidr`, `publicSubnetIds`, `privateSubnetIds`, `databaseSubnetIds`, `intraSubnetIds`, `availabilityZones`, `dbSubnetGroupName`) Task 4 consumes via `StackReference`.

- [ ] **Step 1: Prod zero-diff safety check**

```bash
cd infra/networking && AWS_PROFILE=nucleus-deployment-non-prod pulumi preview --stack prod
```
Expected: `Resources: X unchanged` — **no** creates/updates/deletes. If anything shows a diff, stop and fix Task 1 before continuing.

- [ ] **Step 2: Create the sbx stack config**

Write `infra/networking/Pulumi.sbx.yaml`:
```yaml
config:
  aws:region: ap-south-1
  nucleus-networking:vpcCidr: 10.0.0.0/16
  nucleus-networking:appName: stx-nucleus-ops-sbx
  nucleus-networking:natStrategy: single
```

- [ ] **Step 3: Init the sbx stack**

```bash
cd infra/networking && AWS_PROFILE=nucleus-deployment-non-prod pulumi stack init sbx
```
Expected: `Created stack 'sbx'`.

- [ ] **Step 4: Preview sbx**

```bash
AWS_PROFILE=nucleus-deployment-non-prod pulumi preview --stack sbx
```
Expected: all-create plan (VPC, subnets, NAT gateway ×1, route tables, S3 gateway endpoint, DB subnet group). No resource should reference an existing prod resource ID.

- [ ] **Step 5: Deploy sbx networking**

```bash
AWS_PROFILE=nucleus-deployment-non-prod pulumi up --stack sbx --yes
```
Expected: all resources created successfully.

- [ ] **Step 6: Commit the config file**

```bash
git add infra/networking/Pulumi.sbx.yaml
git commit -m "feat(infra): add sbx networking stack config"
```

---

### Task 3: Parameterize `infra/compute/index.ts`

**Files:**
- Modify: `infra/compute/index.ts`

**Interfaces:**
- Consumes: sbx networking stack outputs (via `pulumi.getStack()`-based `StackReference`, same output names as today — no signature change).
- Config keys consumed: `nucleus-compute:appName`, `nucleus-compute:dbName`, `nucleus-compute:dbUsername`, `nucleus-compute:engineVersion`, `nucleus-compute:workersDesiredCount`, plus existing `appUrl`/`subscriptionEmails`.

- [ ] **Step 1: Replace the hardcoded `appName` and add new config reads**

Change (currently near line 42-46):
```typescript
const appUrl = config.get("appUrl") ?? "https://placeholder.cloudfront.net";
const subscriptionEmails = config.get("subscriptionEmails") ?? "";
const crossAccountRoleName = "NucleusAccess";
const vectorBucketName = "";
const appName = "nucleus-cloud-ops";
```
to:
```typescript
const appUrl = config.get("appUrl") ?? "https://placeholder.cloudfront.net";
const subscriptionEmails = config.get("subscriptionEmails") ?? "";
const crossAccountRoleName = "NucleusAccess";
const vectorBucketName = "";
const appName = config.get("appName") ?? "nucleus-cloud-ops";
const dbName = config.get("dbName") ?? "nucleus";
const dbUsername = config.get("dbUsername") ?? "nucleus_admin";
const engineVersion = config.get("engineVersion") ?? "16.6";
const workersDesiredCount = config.getNumber("workersDesiredCount") ?? 2;
```

- [ ] **Step 2: Make the StackReference dynamic**

Change (currently line 110):
```typescript
const networking = new pulumi.StackReference("organization/nucleus-networking/prod");
```
to:
```typescript
const networking = new pulumi.StackReference(`organization/nucleus-networking/${pulumi.getStack()}`);
```

- [ ] **Step 3: Update the RDS instance to use the new config values**

Change (currently lines 330-346):
```typescript
const postgresInstance = new aws.rds.Instance("postgres", {
    identifier: "nucleus-cloud-ops-postgres",
    engine: "postgres",
    engineVersion: "16.6",
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
to:
```typescript
const postgresInstance = new aws.rds.Instance("postgres", {
    identifier: `${appName}-postgres`,
    engine: "postgres",
    engineVersion: engineVersion,
    instanceClass: "db.t4g.micro",
    dbName: dbName,
    username: dbUsername,
    password: dbPassword,
    dbSubnetGroupName: dbSubnetGroupName,
    vpcSecurityGroupIds: [rdsSecurityGroup.id],
    multiAz: false,
    allocatedStorage: 20,
    storageType: "gp3",
    skipFinalSnapshot: true,
    deletionProtection: false,
    tags: { Name: `${appName}-postgres` },
}, { retainOnDelete: false });
```

- [ ] **Step 4: Update the `database-url` secret string to use `dbUsername`/`dbName`**

Change (currently lines 349-352):
```typescript
new aws.secretsmanager.SecretVersion("database-url-version", {
    secretId: databaseUrlSm.id,
    secretString: pulumi.interpolate`postgresql://nucleus_admin:${dbPasswordRandom.result}@${postgresInstance.address}:5432/nucleus?sslmode=require&uselibpqcompat=true`,
});
```
to:
```typescript
new aws.secretsmanager.SecretVersion("database-url-version", {
    secretId: databaseUrlSm.id,
    secretString: pulumi.interpolate`postgresql://${dbUsername}:${dbPasswordRandom.result}@${postgresInstance.address}:5432/${dbName}?sslmode=require&uselibpqcompat=true`,
});
```

- [ ] **Step 5: Fix the workers `rds-db:connect` IAM policy (previously hardcoded `nucleus_admin`)**

Change (currently lines 1165-1177):
```typescript
new aws.iam.RolePolicy("workers-rds-connect-policy", {
    role: workersTaskRole.id,
    policy: postgresInstance.arn.apply(dbArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["rds-db:connect"],
                Resource: [`${dbArn.replace(':rds:', ':rds-db:').replace(':db:', ':dbuser:')}/nucleus_admin`],
            }],
        })
    ),
});
```
to:
```typescript
new aws.iam.RolePolicy("workers-rds-connect-policy", {
    role: workersTaskRole.id,
    policy: postgresInstance.arn.apply(dbArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["rds-db:connect"],
                Resource: [`${dbArn.replace(':rds:', ':rds-db:').replace(':db:', ':dbuser:')}/${dbUsername}`],
            }],
        })
    ),
});
```

(Same fix applies to the web-ui `ecs-task-rds-connect-policy` at line ~923 — check it: it currently only grants `rds-db:connect` on `postgresInstance.arn` directly, with no hardcoded username suffix, so no change needed there — verify this during Step 8's grep re-check.)

- [ ] **Step 6: Parameterize the CloudWatch custom metrics namespace**

Change (currently lines 1108-1122, both the comment and the policy):
```typescript
// CloudWatch custom metrics (best-effort dead-letter / queue-depth metrics from
// observability.ts). PutMetricData cannot be resource-scoped; namespace is
// constrained via a condition so this cannot publish outside Nucleus/Workers.
new aws.iam.RolePolicy("workers-cloudwatch-metrics-policy", {
    role: workersTaskRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: ["cloudwatch:PutMetricData"],
            Resource: ["*"],
            Condition: { StringEquals: { "cloudwatch:namespace": "Nucleus/Workers" } },
        }],
    }),
});
```
to:
```typescript
// CloudWatch custom metrics (best-effort dead-letter / queue-depth metrics from
// observability.ts). PutMetricData cannot be resource-scoped; namespace is
// constrained via a condition so this cannot publish outside <appName>/Workers.
new aws.iam.RolePolicy("workers-cloudwatch-metrics-policy", {
    role: workersTaskRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: ["cloudwatch:PutMetricData"],
            Resource: ["*"],
            Condition: { StringEquals: { "cloudwatch:namespace": `${appName}/Workers` } },
        }],
    }),
});
```
Note: the workers app code (`apps/workers`) that actually calls `PutMetricData` also hardcodes the `Nucleus/Workers` namespace string — grep it (`grep -rn "Nucleus/Workers" apps/workers/src`) and, if found, it does NOT need to change for this task (it's app runtime code, out of scope for this infra-only plan); flag it as a pre-existing mismatch if the IAM condition would then reject the app's real calls in `sbx` (in which case, either leave the IAM namespace as `Nucleus/Workers` for both stacks — simplest, no functional risk to prod either way — or file a follow-up to make the app's namespace config-driven too). Default to leaving the IAM condition namespace as the literal `"Nucleus/Workers"` (unparameterized) if the grep shows the app code doesn't read it from an env var, since a mismatch here would silently break workers' metrics emission in sbx with no functional harm to prod — **prefer functional correctness over cosmetic isolation** for this one spot.

- [ ] **Step 7: Set `workersDesiredCount` on the workers ECS service**

Change (currently line 1384):
```typescript
    desiredCount: 2,
```
(inside `workersService`) to:
```typescript
    desiredCount: workersDesiredCount,
```

- [ ] **Step 8: Rename every remaining hardcoded `"nucleus-cloud-ops-*"` resource name to `` `${appName}-*` ``**

Full grep-verified list (run `grep -n -i "nucleus" infra/compute/index.ts` after this step — only `crossAccountRoleName = "NucleusAccess"`, the two `NucleusAccess-*` ARN patterns, and the untouched `webUiStackName` dead-code line should remain):

| Resource (logical name) | Old literal | New |
|---|---|---|
| `web-ui-user-pool` name | `"nucleus-cloud-ops-web-ui-user-pool"` | `` `${appName}-web-ui-user-pool` `` |
| `web-ui-user-pool-domain` domain | `` `nucleus-cloud-ops-web-ui-auth-${accountId}` `` | `` pulumi.interpolate`${appName}-web-ui-auth-${accountId}` `` |
| `web-ui-user-pool-client` name | `"nucleus-cloud-ops-web-ui-app-client"` | `` `${appName}-web-ui-app-client` `` |
| `web-ui-identity-pool` identityPoolName | `"nucleus-cloud-ops-web-ui-identity-pool"` | `` `${appName}-web-ui-identity-pool` `` |
| `web-ui-authenticated-role` name | `"nucleus-cloud-ops-web-ui-authenticated-role"` | `` `${appName}-web-ui-authenticated-role` `` |
| `scheduler-sns-topic` name | `"nucleus-cloud-ops-sns-topic"` | `` `${appName}-sns-topic` `` |
| `rds-sg` name | `"nucleus-cloud-ops-rds-sg"` | `` `${appName}-rds-sg` `` |
| `bastion-role` name + tag | `"nucleus-cloud-ops-bastion-role"` | `` `${appName}-bastion-role` `` |
| `bastion-instance-profile` name | `"nucleus-cloud-ops-bastion-profile"` | `` `${appName}-bastion-profile` `` |
| `bastion-sg` name + tag | `"nucleus-cloud-ops-bastion-sg"` | `` `${appName}-bastion-sg` `` |
| `bastion` instance tag | `"nucleus-cloud-ops-bastion"` | `` `${appName}-bastion` `` |
| `web-ui-ecr-repo` name | `"nucleus-cloud-ops-web-ui"` | `` `${appName}-web-ui` `` |
| `web-ui-ecs-cluster` name | `"nucleus-cloud-ops-ecs-cluster"` | `` `${appName}-ecs-cluster` `` |
| `web-ui-log-group` name | `"/ecs/nucleus-cloud-ops-web-ui-service"` | `` `/ecs/${appName}-web-ui-service` `` |
| `ecs-task-execution-role` name | `"nucleus-cloud-ops-ecs-execution-role"` | `` `${appName}-ecs-execution-role` `` |
| `ecs-task-role` name | `"nucleus-cloud-ops-ecs-task-role"` | `` `${appName}-ecs-task-role` `` |
| `web-ui-task-def` family | `"nucleus-cloud-ops-web-ui-task"` | `` `${appName}-web-ui-task` `` |
| `alb-sg` name | `"nucleus-cloud-ops-alb-sg"` | `` `${appName}-alb-sg` `` |
| `ecs-service-sg` name | `"nucleus-cloud-ops-ecs-service-sg"` | `` `${appName}-ecs-service-sg` `` |
| `web-ui-alb` name | `"nucleus-cloud-ops-alb"` | `` `${appName}-alb` `` |
| `web-ui-tg` name | `"nucleus-cloud-ops-web-ui-tg"` | `` `${appName}-web-ui-tg` `` |
| `web-ui-service` name | `"nucleus-cloud-ops-web-ui-service"` | `` `${appName}-web-ui-service` `` |
| `web-ui-cpu-scaling` name | `"nucleus-cloud-ops-web-ui-cpu-scaling"` | `` `${appName}-web-ui-cpu-scaling` `` |
| `web-ui-memory-scaling` name | `"nucleus-cloud-ops-web-ui-memory-scaling"` | `` `${appName}-web-ui-memory-scaling` `` |
| `cognitoDomainPrefix` export | `` `nucleus-cloud-ops-web-ui-auth-${accountId}` `` | `` pulumi.interpolate`${appName}-web-ui-auth-${accountId}` `` |
| CloudFront `comment` | `"Nucleus Cloud Ops WebUI"` | `` `${appName} WebUI` `` |
| `workers-ecr-repo` name | `"nucleus-cloud-ops-workers"` | `` `${appName}-workers` `` |
| `workers-log-group` name | `"/ecs/nucleus-cloud-ops-workers"` | `` `/ecs/${appName}-workers` `` |
| `workers-task-role` name | `"nucleus-cloud-ops-workers-task-role"` | `` `${appName}-workers-task-role` `` |
| `ephemeral-workers-log-group` name | `"/ecs/nucleus-cloud-ops-ephemeral-workers"` | `` `/ecs/${appName}-ephemeral-workers` `` |
| `EPHEMERAL_WORKER_TASK_FAMILY` const | `"nucleus-cloud-ops-ephemeral-worker-task"` | `` `${appName}-ephemeral-worker-task` `` |
| `workers-sg` name | `"nucleus-cloud-ops-workers-sg"` | `` `${appName}-workers-sg` `` |
| `workers-task-def` family | `"nucleus-cloud-ops-workers-task"` | `` `${appName}-workers-task` `` |
| `workers-service` name | `"nucleus-cloud-ops-workers-service"` | `` `${appName}-workers-service` `` |

Do NOT touch: `crossAccountRoleName = "NucleusAccess"` (trusted role name in *spoke* AWS accounts, not a hub-account resource), the two `"arn:aws:iam::*:role/NucleusAccess-*"` ARN patterns, or `webUiStackName` (dead code, unused — leave as-is, out of scope for this change).

- [ ] **Step 9: Verify TypeScript compiles**

Run: `cd infra/compute && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Grep-verify no stray hardcoded names remain**

Run: `grep -n -i "nucleus" infra/compute/index.ts`
Expected: only `crossAccountRoleName`, the two `NucleusAccess-*` ARNs, and `webUiStackName` remain as literal `"nucleus"` strings.

- [ ] **Step 11: Commit**

```bash
git add infra/compute/index.ts
git commit -m "feat(infra): parameterize compute stack by appName for isolated sbx environment"
```

---

### Task 4: Deploy sbx compute stack

**Files:**
- Create: `infra/compute/Pulumi.sbx.yaml`

**Interfaces:**
- Consumes: Task 2's live `sbx` networking stack (via `pulumi.getStack()`-resolved `StackReference`), Task 3's new config keys.

- [ ] **Step 1: Prod zero-diff safety check**

```bash
cd infra/compute && PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=nucleus-deployment-non-prod pulumi preview --stack prod
```
Expected: `Resources: X unchanged` — no creates/updates/deletes/replaces. **This must be pasted and shown before proceeding.** If it shows any diff (e.g. an `engineVersion` upgrade, a renamed resource), stop and fix Task 3's defaults — do not proceed to sbx.

- [ ] **Step 2: Create the sbx stack config**

Write `infra/compute/Pulumi.sbx.yaml`:
```yaml
config:
  aws:region: ap-south-1
  nucleus-compute:appName: stx-nucleus-ops-sbx
  nucleus-compute:appUrl: https://placeholder.cloudfront.net
  nucleus-compute:subscriptionEmails: ""
  nucleus-compute:engineVersion: "16.9"
  nucleus-compute:workersDesiredCount: "1"
  nucleus-compute:dbName: nucleus_sbx
  nucleus-compute:dbUsername: nucleus_sbx_admin
```

- [ ] **Step 3: Init the sbx stack**

```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=nucleus-deployment-non-prod pulumi stack init --secrets-provider=passphrase sbx
```
Expected: `Created stack 'sbx'`.

- [ ] **Step 4: Preview sbx**

```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=nucleus-deployment-non-prod pulumi preview --stack sbx
```
Expected: all-create plan (~80+ resources: RDS, ECS cluster/services/task-defs, ALB, target group, CloudFront, Cognito, ECR repos + Docker image builds, Secrets Manager, IAM roles, security groups, SNS topic, bastion). Confirm every resource name in the plan is prefixed `stx-nucleus-ops-sbx-` (or under `stx-nucleus-ops-sbx/...` for Secrets Manager) — no reference to any `nucleus-cloud-ops-*` name.

- [ ] **Step 5: Deploy sbx compute**

```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=nucleus-deployment-non-prod pulumi up --stack sbx --yes
```
Expected: all resources created. This includes two Docker image builds (web-ui + workers) — expect ~20-25 minutes total, matching the chatbot nonprod precedent.

- [ ] **Step 6: Read the real CloudFront URL and update the config**

```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=nucleus-deployment-non-prod pulumi stack output cloudFrontUrl --stack sbx
```
Update `infra/compute/Pulumi.sbx.yaml`'s `appUrl` value to the real URL (replacing `https://placeholder.cloudfront.net`), then:
```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=nucleus-deployment-non-prod pulumi up --stack sbx --yes
```
Expected: fast update (~2-3 min) — only Cognito callback/logout URLs and ECS task-def env vars change, no image rebuild.

- [ ] **Step 7: Verify the live sbx environment**

```bash
AWS_PROFILE=nucleus-deployment-non-prod aws ecs describe-services \
  --cluster stx-nucleus-ops-sbx-ecs-cluster \
  --services stx-nucleus-ops-sbx-web-ui-service stx-nucleus-ops-sbx-workers-service \
  --region ap-south-1 \
  --query "services[*].{name:serviceName,status:status,desired:desiredCount,running:runningCount}" \
  --output table

curl -s -o /dev/null -w "HTTP %{http_code}\n" "$(PULUMI_CONFIG_PASSPHRASE='' AWS_PROFILE=nucleus-deployment-non-prod pulumi stack output cloudFrontUrl --stack sbx)"
```
Expected: web-ui `1/1` running, workers `1/1` running, `HTTP 307` (redirect to Cognito sign-in — same behavior as prod today).

- [ ] **Step 8: Re-verify prod is still untouched**

```bash
AWS_PROFILE=nucleus-deployment-non-prod aws ecs describe-services \
  --cluster nucleus-cloud-ops-ecs-cluster \
  --services nucleus-cloud-ops-web-ui-service nucleus-cloud-ops-workers-service \
  --region ap-south-1 \
  --query "services[*].{name:serviceName,status:status,desired:desiredCount,running:runningCount}" \
  --output table
```
Expected: unchanged from before this work — web-ui `1/1`, workers `2/2`.

- [ ] **Step 9: Commit**

```bash
git add infra/compute/Pulumi.sbx.yaml
git commit -m "feat(infra): add sbx compute stack config"
```

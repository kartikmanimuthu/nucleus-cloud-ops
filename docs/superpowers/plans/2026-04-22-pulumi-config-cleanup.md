# Pulumi Config Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lean Pulumi config — passphrase secrets provider (empty passphrase), dynamic secret generation via AWS Secrets Manager, remove dead config vars, and move vpcCidr into networking stack config.

**Architecture:** Replace KMS secrets provider with passphrase (`""`) on both stacks. Generate `nextauthSecret` and `dbPassword` dynamically with `random.RandomPassword`, store them in AWS Secrets Manager, and inject into ECS via `secrets:` (valueFrom) rather than plaintext `environment:`. Remove dead config vars (`crossAccountRoleName`, `vectorBucketName`) by inlining their defaults. Add `vpcCidr` to `Pulumi.prod.yaml` for networking stack.

**Tech Stack:** Pulumi TypeScript, `@pulumi/random` ^4.19.1, `@pulumi/aws` ^7.23.0, AWS Secrets Manager, ECS task definition `secrets:` injection.

---

## File Map

| File | Change |
|---|---|
| `infra/networking/Pulumi.prod.yaml` | Create — add `aws:region` + `nucleus-networking:vpcCidr` |
| `infra/compute/Pulumi.prod.yaml` | Create — lean config, passphrase provider, no secrets |
| `infra/networking/index.ts` | No change needed — `config.get("vpcCidr") ?? "10.0.0.0/16"` already reads from config |
| `infra/compute/index.ts` | Remove `config.requireSecret` calls, remove dead config vars, add Secrets Manager resources, switch ECS to `secrets:` injection |

---

### Task 1: Create `infra/networking/Pulumi.prod.yaml`

**Files:**
- Create: `infra/networking/Pulumi.prod.yaml`

- [ ] **Step 1: Create the networking stack config file**

```yaml
config:
  aws:region: ap-south-1
  nucleus-networking:vpcCidr: 10.0.0.0/16
```

- [ ] **Step 2: Verify networking stack reads it correctly**

```bash
cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi config --stack prod
```

Expected output includes `nucleus-networking:vpcCidr  10.0.0.0/16`

- [ ] **Step 3: Commit**

```bash
git add infra/networking/Pulumi.prod.yaml
git commit -m "chore(infra): add networking Pulumi.prod.yaml with vpcCidr config"
```

---

### Task 2: Switch compute stack to passphrase secrets provider

**Files:**
- Create: `infra/compute/Pulumi.prod.yaml`

The passphrase is `""` (empty string). Pulumi reads it from the `PULUMI_CONFIG_PASSPHRASE` env var — set it to empty string in CI/CD and locally.

- [ ] **Step 1: Re-initialize the compute stack with passphrase provider**

Run this from `infra/compute/`. This migrates the existing stack state to use passphrase encryption instead of KMS.

```bash
cd infra/compute
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN \
  pulumi stack change-secrets-provider passphrase --stack prod
```

Expected: `Successfully changed secrets provider to passphrase`

- [ ] **Step 2: Create the lean `Pulumi.prod.yaml`**

After the migration, the stack config file will be rewritten by Pulumi. Verify it looks like this (Pulumi rewrites it — check and trim any leftover dead keys):

```yaml
config:
  aws:region: ap-south-1
  nucleus-compute:appUrl: https://d11lr8aqp8vqde.cloudfront.net
  nucleus-compute:subscriptionEmails: ""
secretsprovider: passphrase
```

If `nucleus-compute:nextauthSecret` or `nucleus-compute:dbPassword` still appear (from the old KMS-encrypted values), remove them — they will be replaced by dynamic generation in Task 3.

```bash
cd infra/compute
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi config rm nextauthSecret --stack prod
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi config rm dbPassword --stack prod
```

- [ ] **Step 3: Commit**

```bash
git add infra/compute/Pulumi.prod.yaml
git commit -m "chore(infra): migrate compute stack to passphrase secrets provider"
```

---

### Task 3: Generate secrets dynamically and store in AWS Secrets Manager

**Files:**
- Modify: `infra/compute/index.ts` — replace `config.requireSecret` with `random.RandomPassword` + `aws.secretsmanager.Secret`

- [ ] **Step 1: Replace the two `config.requireSecret` lines with dynamic generation**

Find lines 46–47 in `infra/compute/index.ts`:

```typescript
const nextauthSecret = config.requireSecret("nextauthSecret");
const dbPassword = config.requireSecret("dbPassword");
```

Replace with:

```typescript
// Dynamically generated — stored in AWS Secrets Manager, never in Pulumi config
const nextauthSecretRandom = new random.RandomPassword("nextauth-secret-random", {
    length: 32,
    special: false,
    keepers: { version: "1" },
});

const dbPasswordRandom = new random.RandomPassword("db-password-random", {
    length: 24,
    special: false,
    keepers: { version: "1" },
});

const nextauthSecretSm = new aws.secretsmanager.Secret("nextauth-secret", {
    name: `${appName}/nextauth-secret`,
    description: "NextAuth.js secret for JWT signing",
    recoveryWindowInDays: 0,
});

new aws.secretsmanager.SecretVersion("nextauth-secret-version", {
    secretId: nextauthSecretSm.id,
    secretString: nextauthSecretRandom.result,
});

const dbPasswordSm = new aws.secretsmanager.Secret("db-password", {
    name: `${appName}/db-password`,
    description: "RDS PostgreSQL admin password",
    recoveryWindowInDays: 0,
});

new aws.secretsmanager.SecretVersion("db-password-version", {
    secretId: dbPasswordSm.id,
    secretString: dbPasswordRandom.result,
});

const nextauthSecret = nextauthSecretRandom.result;
const dbPassword = dbPasswordRandom.result;
```

Note: `nextauthSecret` and `dbPassword` remain as `pulumi.Output<string>` — all downstream code that uses them is unchanged.

- [ ] **Step 2: Grant ECS execution role access to read both secrets**

After the existing `RolePolicyAttachment` for `ecsTaskExecutionRole` (around line 409), add:

```typescript
new aws.iam.RolePolicy("ecs-execution-role-secrets-policy", {
    role: ecsTaskExecutionRole.id,
    policy: pulumi.all([nextauthSecretSm.arn, dbPasswordSm.arn]).apply(
        ([nextauthArn, dbArn]) =>
            JSON.stringify({
                Version: "2012-10-17",
                Statement: [{
                    Effect: "Allow",
                    Action: ["secretsmanager:GetSecretValue"],
                    Resource: [nextauthArn, dbArn],
                }],
            })
    ),
});
```

- [ ] **Step 3: Switch ECS web-ui task definition to inject secrets via `secrets:` not `environment:`**

In the `containerDefinitions` for `webUiTaskDef` (around line 532), the `pulumi.all([...])` call currently includes `nextauthSecret` and `databaseUrl` in the array. 

Change the approach: keep `DATABASE_URL` and `NEXTAUTH_SECRET` out of the `environment:` array and add a `secrets:` array instead. This means ECS pulls the values from Secrets Manager at task start — they never appear in plaintext in the task definition.

In the `pulumi.all([...])` for `webUiTaskDef`, add `nextauthSecretSm.arn` and `dbPasswordSm.arn` to the inputs:

```typescript
containerDefinitions: pulumi.all([
    userPool.id,
    userPoolClient.id,
    userPoolClient.clientSecret,
    identityPool.id,
    inventoryBucket.bucket,
    kbStagingBucket.bucket,
    agentTempBucket.bucket,
    ecsTaskRole.arn,
    webUiLogGroup.name,
    accountId,
    databaseUrl,           // still needed to build DATABASE_URL secret value
    webUiImage.imageUri,
    nextauthSecretSm.arn,  // ARN for secrets: injection
    dbPasswordSm.arn,      // ARN for secrets: injection
]).apply(([
    cognitoPoolId, cognitoClientId, cognitoClientSecret, identityPoolId,
    inventoryBucketN, kbStagingBucketN, agentTempBucketN, ecsTaskRoleArnVal,
    webUiLogGroupN, acctId, databaseUrlVal, imageUri,
    nextauthSecretArn, dbPasswordArn,
]) => JSON.stringify([{
    name: "WebUIContainer",
    image: imageUri,
    essential: true,
    portMappings: [{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }],
    logConfiguration: {
        logDriver: "awslogs",
        options: {
            "awslogs-group": webUiLogGroupN,
            "awslogs-region": region,
            "awslogs-stream-prefix": "web-ui",
        },
    },
    secrets: [
        { name: "NEXTAUTH_SECRET", valueFrom: nextauthSecretArn },
        { name: "DATABASE_URL", valueFrom: dbPasswordArn },
    ],
    environment: [
        // ... all existing env vars EXCEPT NEXTAUTH_SECRET and DATABASE_URL
    ],
}]))
```

**Important:** Remove `{ name: "NEXTAUTH_SECRET", value: nextauthSecretVal }` and `{ name: "DATABASE_URL", value: databaseUrlVal }` from the `environment:` array. They are now in `secrets:`.

For `DATABASE_URL` specifically — the full connection string is assembled from `dbPassword`. Since we're injecting `dbPassword` via Secrets Manager, we need to store the full connection string as the secret value. Update the `dbPasswordSm` secret to store the full URL instead:

```typescript
// Store full DATABASE_URL in Secrets Manager (not just the password)
new aws.secretsmanager.SecretVersion("db-password-version", {
    secretId: dbPasswordSm.id,
    secretString: pulumi.interpolate`postgresql://nucleus_admin:${dbPasswordRandom.result}@${postgresInstance.address}:5432/nucleus`,
});
```

And rename `dbPasswordSm` to `databaseUrlSm` for clarity:

```typescript
const databaseUrlSm = new aws.secretsmanager.Secret("database-url", {
    name: `${appName}/database-url`,
    description: "Full PostgreSQL connection string for ECS tasks",
    recoveryWindowInDays: 0,
});

new aws.secretsmanager.SecretVersion("database-url-version", {
    secretId: databaseUrlSm.id,
    secretString: pulumi.interpolate`postgresql://nucleus_admin:${dbPasswordRandom.result}@${postgresInstance.address}:5432/nucleus`,
});
```

Then in `secrets:`:
```typescript
secrets: [
    { name: "NEXTAUTH_SECRET", valueFrom: nextauthSecretSm.arn },
    { name: "DATABASE_URL", valueFrom: databaseUrlSm.arn },
],
```

- [ ] **Step 4: Apply same `secrets:` pattern to workers task definition**

The workers task definition (around line 1101) also uses `DATABASE_URL`. Apply the same change — add `databaseUrlSm.arn` to its `pulumi.all([...])` and move `DATABASE_URL` to `secrets:`.

```typescript
secrets: [
    { name: "DATABASE_URL", valueFrom: databaseUrlSm.arn },
],
```

Remove `{ name: "DATABASE_URL", value: ... }` from its `environment:` array.

- [ ] **Step 5: Apply same `secrets:` pattern to ephemeral workers task definition**

Same as Step 4 — find the ephemeral workers task definition (around line 1191) and move `DATABASE_URL` to `secrets:`.

- [ ] **Step 6: Commit**

```bash
git add infra/compute/index.ts
git commit -m "feat(infra): generate secrets dynamically via Secrets Manager, inject via ECS secrets:"
```

---

### Task 4: Remove dead config vars from compute stack

**Files:**
- Modify: `infra/compute/index.ts` — inline `crossAccountRoleName` and `vectorBucketName` defaults

- [ ] **Step 1: Replace `config.get` calls with inline constants**

Find lines 44–45:

```typescript
const crossAccountRoleName = config.get("crossAccountRoleName") ?? "NucleusAccess";
const vectorBucketName = config.get("vectorBucketName") ?? "";
```

Replace with:

```typescript
const crossAccountRoleName = "NucleusAccess";
const vectorBucketName = "";
```

- [ ] **Step 2: Verify no other config reads remain that aren't in Pulumi.prod.yaml**

```bash
grep -n "config\.get\|config\.require" infra/compute/index.ts
```

Expected output — only these two lines should remain:
```
42:const appUrl = config.get("appUrl") ?? "https://placeholder.cloudfront.net";
43:const subscriptionEmails = config.get("subscriptionEmails") ?? "";
```

- [ ] **Step 3: Commit**

```bash
git add infra/compute/index.ts
git commit -m "chore(infra): inline crossAccountRoleName and vectorBucketName defaults, remove dead config"
```

---

### Task 5: Preview and validate

- [ ] **Step 1: Preview networking stack (no changes expected)**

```bash
cd infra/networking
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi preview --stack prod
```

Expected: no changes (VPC config matches existing state).

- [ ] **Step 2: Preview compute stack**

```bash
cd infra/compute
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi preview --stack prod
```

Expected changes:
- `+` `aws:secretsmanager/secret:Secret` — `nextauth-secret`
- `+` `aws:secretsmanager/secretVersion:SecretVersion` — `nextauth-secret-version`
- `+` `aws:secretsmanager/secret:Secret` — `database-url`
- `+` `aws:secretsmanager/secretVersion:SecretVersion` — `database-url-version`
- `+` `aws:iam/rolePolicy:RolePolicy` — `ecs-execution-role-secrets-policy`
- `~` `aws:ecs/taskDefinition:TaskDefinition` — `web-ui-task-def` (updated container def)
- `~` `aws:ecs/taskDefinition:TaskDefinition` — `workers-task-def`
- `~` `aws:ecs/taskDefinition:TaskDefinition` — `ephemeral-worker-task-def`
- `-` `random:index/randomPassword:RandomPassword` — old KMS-backed secrets (if any)

No deletions of RDS, ECS services, or networking resources.

- [ ] **Step 3: Commit final state**

```bash
git add infra/compute/Pulumi.prod.yaml infra/networking/Pulumi.prod.yaml
git commit -m "chore(infra): finalize lean Pulumi stack configs"
```

---

## Local Dev Workflow After This Change

Set `PULUMI_CONFIG_PASSPHRASE=""` before any Pulumi command:

```bash
export PULUMI_CONFIG_PASSPHRASE=""
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

Or inline:
```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

For CI/CD, set `PULUMI_CONFIG_PASSPHRASE` as an environment variable with value `""`.

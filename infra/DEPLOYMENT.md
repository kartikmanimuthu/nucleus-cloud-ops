# Pulumi Deployment Guide

## Quick Deploy

```bash
# Networking (only when VPC/subnets change)
cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes

# Compute (builds lambdas + Docker image + deploys everything automatically)
PULUMI_CONFIG_PASSPHRASE="" cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

> **Note:** The compute stack uses a passphrase secrets provider with an empty passphrase.
> Always set `PULUMI_CONFIG_PASSPHRASE=""` before any `pulumi` command in `infra/compute/`.
> For CI/CD, set `PULUMI_CONFIG_PASSPHRASE` as an environment variable with value `""`.
> The networking stack has no secrets and does not require this variable.

---

## How Automated Builds Work

The compute stack auto-detects source changes and builds/deploys without manual steps:

| What changed | What Pulumi does automatically |
|---|---|
| `lambda/scheduler/src/` | Runs `build-lambdas.sh --lambda=scheduler`, uploads new zip |
| `lambda/vector_processor/src/` | Runs `build-lambdas.sh --lambda=vector_processor`, uploads new zip |
| `lambda/kb_sync_processor/src/` | Runs `build-lambdas.sh --lambda=kb_sync_processor`, uploads new zip |
| `web-ui/` or `prisma/` | Builds ARM64 Docker image, pushes to ECR with unique digest, creates new ECS task definition revision, ECS rolls out new tasks |

No manual `build-lambdas.sh`, `build-images.sh`, or `aws ecs update-service` needed.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | `nvm install 20` |
| Pulumi CLI | 3.x | `brew install pulumi` |
| AWS CLI | v2 | `brew install awscli` |
| Docker | any | Docker Desktop |

```bash
aws configure --profile PLATFORM-ADMIN
aws sts get-caller-identity --profile PLATFORM-ADMIN  # verify
```

---

## Stack Structure

```
infra/
├── bootstrap/        # One-time S3 state backend + KMS key setup
├── networking/       # Pulumi stack — VPC, subnets, subnet groups
├── compute/          # Pulumi stack — ECS, Lambda, RDS, DynamoDB, Cognito, CloudFront
├── build-lambdas.sh  # Lambda build script (called automatically by pulumi up)
└── build-images.sh   # Manual Docker build script (no longer needed for normal deploys)
```

Pulumi state: `s3://nucleus-pulumi-state` (us-east-1) · Secrets: `alias/pulumi-secrets`

---

## First-Time Setup

### 1. Bootstrap S3 state backend (one-time, per account)

```bash
cd infra/bootstrap && bash bootstrap.sh
```

Creates `nucleus-pulumi-state` S3 bucket + `alias/pulumi-secrets` KMS key, logs Pulumi into the S3 backend.

### 2. Install dependencies

```bash
cd infra/networking && npm install && pulumi install
cd infra/compute && npm install && pulumi install
```

Both `npm install` and `pulumi install` are required — `npm install` alone is not enough.

### 3. Initialize stacks (first time only)

```bash
cd infra/networking
pulumi stack init prod --stack prod

cd infra/compute
PULUMI_CONFIG_PASSPHRASE="" pulumi stack init prod --secrets-provider=passphrase --stack prod
```

### 4. Set required config (no secrets needed)

Secrets (`NEXTAUTH_SECRET`, `DATABASE_URL`) are generated automatically by Pulumi on first deploy and stored in AWS Secrets Manager. No manual `pulumi config set --secret` steps required.

Only non-secret config values need to be set:

```bash
cd infra/compute
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi config set appUrl "https://d11lr8aqp8vqde.cloudfront.net" --stack prod
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi config set subscriptionEmails "" --stack prod
```

---

## Deploy Order

```
1. infra/networking  →  VPC, subnets, subnet groups
2. infra/compute     →  Everything else (reads networking outputs via StackReference)
```

The compute stack uses `requireOutput()` — it fails at preview time if networking is not deployed first.

---

## Key Stack Outputs

| Output | Value | Description |
|--------|-------|-------------|
| `cloudFrontUrl` | `https://d11lr8aqp8vqde.cloudfront.net` | Public app URL |
| `postgresEndpoint` | `nucleus-cloud-ops-postgres.*.ap-south-1.rds.amazonaws.com` | RDS hostname |
| `bastionInstanceId` | `i-xxxxxxxxxxxxxxxxx` | Bastion EC2 instance ID (for SSM tunnel) |
| `ecsClusterName` | `nucleus-cloud-ops-ecs-cluster` | ECS cluster name |
| `cognitoUserPoolId` | `ap-south-1_xxxxxxxxx` | Cognito pool ID |
| `ecrRepositoryUri` | `*.dkr.ecr.ap-south-1.amazonaws.com/nucleus-cloud-ops-web-ui` | ECR image repo |

```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi stack output --stack prod
```

> `NEXTAUTH_SECRET` and `DATABASE_URL` are no longer stack outputs — they live in AWS Secrets Manager
> under `nucleus-cloud-ops/nextauth-secret` and `nucleus-cloud-ops/database-url`.

---

## Secrets Management

Secrets are generated automatically on first `pulumi up` and stored in AWS Secrets Manager. No manual secret rotation or config file edits needed.

| Secret name | Path in Secrets Manager | Injected as |
|---|---|---|
| NextAuth JWT secret | `nucleus-cloud-ops/nextauth-secret` | `NEXTAUTH_SECRET` (ECS secrets:) |
| PostgreSQL connection string | `nucleus-cloud-ops/database-url` | `DATABASE_URL` (ECS secrets:) |

To rotate a secret, update the `keepers.version` value in `infra/compute/index.ts` for the relevant `random.RandomPassword` resource and run `pulumi up`. Pulumi generates a new value, updates Secrets Manager, and ECS rolls out new tasks automatically.

To read the current value:

```bash
AWS_PROFILE=PLATFORM-ADMIN aws secretsmanager get-secret-value \
  --secret-id nucleus-cloud-ops/database-url \
  --query SecretString --output text
```

---

## Connecting to the Database (SSM Tunnel)

The RDS instance is in a private subnet with no public access. Use the bastion EC2 instance via AWS Session Manager — no SSH key or open inbound port required.

### Prerequisites

```bash
# Install Session Manager plugin
brew install --cask session-manager-plugin

# Verify
session-manager-plugin --version
```

### Step 1: Get the bastion instance ID

```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN \
  pulumi stack output bastionInstanceId --stack prod
# → i-xxxxxxxxxxxxxxxxx
```

### Step 2: Get the RDS hostname

```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN \
  pulumi stack output postgresEndpoint --stack prod
# → nucleus-cloud-ops-postgres.cfsuk8eescim.ap-south-1.rds.amazonaws.com
```

### Step 3: Open the SSM port-forward tunnel

```bash
AWS_PROFILE=PLATFORM-ADMIN aws ssm start-session \
  --target i-xxxxxxxxxxxxxxxxx \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{
    "host": ["nucleus-cloud-ops-postgres.cfsuk8eescim.ap-south-1.rds.amazonaws.com"],
    "portNumber": ["5432"],
    "localPortNumber": ["5433"]
  }'
```

Leave this terminal open. The tunnel is now available at `localhost:5433`.

### Step 4: Connect with psql (new terminal)

```bash
# Get the connection string from Secrets Manager
DB_URL=$(AWS_PROFILE=PLATFORM-ADMIN aws secretsmanager get-secret-value \
  --secret-id nucleus-cloud-ops/database-url \
  --query SecretString --output text)

# Replace the RDS hostname with localhost:5433
psql "${DB_URL/nucleus-cloud-ops-postgres.*ap-south-1.rds.amazonaws.com:5432/localhost:5433}"
```

Or connect manually:

```bash
psql "postgresql://nucleus_admin:<password>@localhost:5433/nucleus?sslmode=require"
```

### Step 5: Close the tunnel

Press `Ctrl+C` in the SSM terminal when done.

---

## PostgreSQL Feature Flags

All 10 flags are `true` in the ECS task definition — all entities route to PostgreSQL:

```
USE_PG_ACCOUNTS=true  USE_PG_SCHEDULES=true  USE_PG_AUDIT=true  USE_PG_AUDIT_LOGS=true
USE_PG_INVENTORY=true  USE_PG_AGENT_OPS=true  USE_PG_LANGGRAPH=true  USE_PG_RBAC=true
USE_PG_TENANT_CONFIG=true  USE_PG_KB=true
```

To roll back a specific entity to DynamoDB, set its flag to `false` in `infra/compute/index.ts` and run `pulumi up`.

---

## Rollback

```bash
# Option 1 — revert code and redeploy
git revert HEAD
PULUMI_CONFIG_PASSPHRASE="" cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod

# Option 2 — remove a specific resource from state and recreate
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi state delete <resource-urn> --stack prod
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod
```

---

## Troubleshooting

**`Pulumi SDK has not been installed` error**
Run `npm install && pulumi install` in the stack directory. Both are required.

**`requireOutput()` fails at preview**
Deploy networking first: `cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod`

**`npm error could not determine executable to run` with `npx pulumi`**
Use the global `pulumi` CLI directly (`brew install pulumi`), not `npx pulumi`.

**`error: passphrase must be set` or passphrase prompt appears**
Set `PULUMI_CONFIG_PASSPHRASE=""` before the command:
```bash
PULUMI_CONFIG_PASSPHRASE="" AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod
```

**ECR Public 403 Forbidden during Docker build**
BuildKit doesn't use stored ECR Public credentials automatically. Fix:
```bash
AWS_PROFILE=PLATFORM-ADMIN aws ecr-public get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin public.ecr.aws
docker pull public.ecr.aws/docker/library/node:20.9.0-slim
```

**Docker build fails with `/prisma: not found`**
The `Dockerfile.ecs` copies `../prisma/` which is outside `web-ui/`. The build context must be the repo root, not `web-ui/`. This is already handled in `infra/compute/index.ts` (`context: repoRoot`).

**RDS version not found**
```bash
AWS_PROFILE=PLATFORM-ADMIN aws rds describe-db-engine-versions \
  --engine postgres --region ap-south-1 \
  --query "DBEngineVersions[*].EngineVersion" --output text | tr '\t' '\n' | grep "^16\."
```

**ECS service not updating after `pulumi up`**
The `awsx.ecr.Image` integration tags images with a unique digest — ECS task definition gets a new revision automatically and ECS rolls out new tasks. No manual `force-new-deployment` needed.

**SSM tunnel: `TargetNotConnected` error**
The bastion instance may not have SSM agent running yet (first boot) or the instance profile hasn't propagated. Wait 2–3 minutes after first deploy, then retry. Verify the instance is reachable:
```bash
AWS_PROFILE=PLATFORM-ADMIN aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=i-xxxxxxxxxxxxxxxxx"
```
The instance should appear with `PingStatus: Online`.

**SSM tunnel: `An error occurred (AccessDeniedException)`**
Your local AWS profile needs `ssm:StartSession` permission on the bastion instance. Check your IAM policy includes:
```json
{
  "Effect": "Allow",
  "Action": ["ssm:StartSession"],
  "Resource": "arn:aws:ec2:ap-south-1:<account>:instance/i-xxxxxxxxxxxxxxxxx"
}
```


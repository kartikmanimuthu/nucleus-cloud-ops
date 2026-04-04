# Pulumi Deployment Guide

## Quick Deploy

```bash
# Networking (only when VPC/subnets change)
cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes

# Compute (builds lambdas + Docker image + deploys everything automatically)
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

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
pulumi stack init prod --secrets-provider="awskms://alias/pulumi-secrets?region=us-east-1"

cd infra/compute
pulumi stack init prod --secrets-provider="awskms://alias/pulumi-secrets?region=us-east-1"
```

### 4. Set required secrets

```bash
cd infra/compute
pulumi config set --secret nextauthSecret "your-nextauth-secret" --stack prod
pulumi config set --secret dbPassword "your-db-password" --stack prod
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
| `postgresEndpoint` | `nucleus-cloud-ops-postgres.cfsuk8eescim.us-east-1.rds.amazonaws.com` | RDS hostname |
| `databaseUrl` | *(secret)* | Full PostgreSQL connection string |
| `ecsClusterName` | `nucleus-cloud-ops-ecs-cluster` | ECS cluster name |
| `cognitoUserPoolId` | `us-east-1_9LrfcxzCC` | Cognito pool ID |
| `ecrRepositoryUri` | `970547372609.dkr.ecr.us-east-1.amazonaws.com/nucleus-cloud-ops-web-ui` | ECR image repo |

```bash
AWS_PROFILE=PLATFORM-ADMIN pulumi stack output --stack prod
AWS_PROFILE=PLATFORM-ADMIN pulumi stack output databaseUrl --show-secrets --stack prod
```

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
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod

# Option 2 — remove a specific resource from state and recreate
AWS_PROFILE=PLATFORM-ADMIN pulumi state delete <resource-urn> --stack prod
AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod
```

---

## Troubleshooting

**`Pulumi SDK has not been installed` error**
Run `npm install && pulumi install` in the stack directory. Both are required.

**`requireOutput()` fails at preview**
Deploy networking first: `cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod`

**`npm error could not determine executable to run` with `npx pulumi`**
Use the global `pulumi` CLI directly (`brew install pulumi`), not `npx pulumi`.

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
  --engine postgres --region us-east-1 \
  --query "DBEngineVersions[*].EngineVersion" --output text | tr '\t' '\n' | grep "^16\."
```

**ECS service not updating after `pulumi up`**
The new `awsx.ecr.Image` integration tags images with a unique digest — ECS task definition gets a new revision automatically and ECS rolls out new tasks. No manual `force-new-deployment` needed.


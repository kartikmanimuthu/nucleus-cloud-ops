# Pulumi Deployment Guide

## Quick Deploy Commands

```bash
# Networking stack (run first, only needed when VPC/subnets change)
cd infra/networking
AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod

# Compute stack (most common — ECS, Lambda, RDS, DynamoDB, Cognito)
cd infra/compute
AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod
```

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | `nvm install 20` |
| Pulumi CLI | latest | `brew install pulumi` |
| AWS CLI | v2 | `brew install awscli` |
| Docker | any | Docker Desktop |

AWS profile must be configured:
```bash
aws configure --profile PLATFORM-ADMIN
# or
export AWS_PROFILE=PLATFORM-ADMIN
aws sts get-caller-identity  # verify
```

---

## First-Time Setup

### 1. Bootstrap S3 state backend (one-time, per account)

```bash
cd infra/bootstrap
bash bootstrap.sh
```

This creates the S3 bucket and KMS key used by Pulumi for state + secrets.

### 2. Install dependencies

```bash
cd infra/networking && npm install
cd infra/compute && npm install
```

### 3. Set required secrets

```bash
cd infra/compute

# NextAuth secret
pulumi config set --secret nextauthSecret "your-nextauth-secret" --stack prod

# RDS PostgreSQL password
pulumi config set --secret dbPassword "your-db-password" --stack prod
```

---

## Build Artifacts (required before compute deploy)

### Lambda zip files

```bash
# From repo root
bash infra/build-lambdas.sh
```

Produces:
- `lambda/scheduler/lambda.zip`
- `lambda/vector_processor/lambda.zip`
- `lambda/kb_sync_processor/lambda.zip`

### Docker image (WebUI)

```bash
# From repo root
bash infra/build-images.sh

# Then set the image URI in Pulumi config
cd infra/compute
pulumi config set webUiImageUri "970547372609.dkr.ecr.us-east-1.amazonaws.com/nucleus-cloud-ops-web-ui:latest" --stack prod
```

---

## Deploy Order

Stacks have a hard dependency — always deploy in this order:

```
1. infra/networking  →  VPC, subnets, subnet groups
2. infra/compute     →  Everything else (reads networking outputs)
```

The compute stack uses `requireOutput()` on the networking stack — it will fail at preview time if networking is not deployed.

---

## Full Deploy Workflow

```bash
# 1. Build lambda zips
bash infra/build-lambdas.sh

# 2. Preview changes (always review before applying)
cd infra/compute
AWS_PROFILE=PLATFORM-ADMIN pulumi preview --stack prod

# 3. Deploy
AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod

# 4. Confirm outputs
AWS_PROFILE=PLATFORM-ADMIN pulumi stack output --stack prod
```

---

## Key Stack Outputs

| Output | Description |
|--------|-------------|
| `cloudFrontUrl` | Public app URL |
| `postgresEndpoint` | RDS hostname |
| `databaseUrl` | Full connection string (secret) |
| `ecsClusterName` | ECS cluster name |
| `cognitoUserPoolId` | Cognito pool ID |

```bash
# View all outputs
AWS_PROFILE=PLATFORM-ADMIN pulumi stack output --stack prod

# View secret output
AWS_PROFILE=PLATFORM-ADMIN pulumi stack output databaseUrl --show-secrets --stack prod
```

---

## PostgreSQL Feature Flags

All 10 flags are set to `true` in the ECS task definition — DynamoDB is disabled for the WebUI:

```
USE_PG_ACCOUNTS=true
USE_PG_SCHEDULES=true
USE_PG_AUDIT=true
USE_PG_AUDIT_LOGS=true
USE_PG_INVENTORY=true
USE_PG_AGENT_OPS=true
USE_PG_LANGGRAPH=true
USE_PG_RBAC=true
USE_PG_TENANT_CONFIG=true
USE_PG_KB=true
```

To roll back to DynamoDB for a specific entity, set the corresponding flag to `false` in `infra/compute/index.ts` and redeploy.

---

## Rollback

Pulumi has no built-in rollback. Options:

```bash
# Option 1 — revert code and redeploy
git revert HEAD
AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod

# Option 2 — destroy a specific resource and let Pulumi recreate it
AWS_PROFILE=PLATFORM-ADMIN pulumi state delete <resource-urn> --stack prod
AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod
```

---

## Troubleshooting

**`requireOutput()` fails at preview**
Networking stack is not deployed. Run `cd infra/networking && pulumi up --stack prod` first.

**Lambda zip not found**
Run `bash infra/build-lambdas.sh` from repo root before deploying.

**RDS version not found**
Check available versions: `AWS_PROFILE=PLATFORM-ADMIN aws rds describe-db-engine-versions --engine postgres --region us-east-1 --query "DBEngineVersions[*].EngineVersion" --output text | tr '\t' '\n' | grep "^16\."`. Use the lowest available (currently `16.6`).

**CFN stack in ROLLBACK_COMPLETE**
Remove from Pulumi state: `pulumi state delete <urn> --yes --stack prod`, then redeploy.

**ECS service not updating**
`forceNewDeployment: true` is set — ECS will replace tasks on next `pulumi up`. Check ECS console for deployment status.

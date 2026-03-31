---
quick_task: 260331-rpk
description: Create PostgreSQL RDS database in Pulumi and wire DATABASE_URL to all services
status: complete
date: 2026-03-31
files_modified:
  - infra/compute/index.ts
  - infra/compute/Pulumi.prod.yaml
---

# Summary

Added RDS PostgreSQL to the Pulumi compute stack and wired `DATABASE_URL` to all dependent services.

## What Was Done

- Added `dbPassword = config.requireSecret("dbPassword")` to config block
- Created `rdsSecurityGroup` — allows port 5432 from VPC CIDR (10.0.0.0/16)
- Created `postgresInstance` — postgres 16.3, db.t4g.micro, 20 GB gp3, in `dbSubnetGroupName` subnets from networking stack
- Constructed `databaseUrl` as `pulumi.secret(pulumi.interpolate\`postgresql://nucleus_admin:${dbPassword}@${postgresInstance.address}:5432/nucleus\`)`
- Wired `DATABASE_URL` to: Scheduler Lambda, VectorProcessor Lambda, KBSyncProcessor Lambda, Discovery ECS task def, WebUI ECS task def
- Added `rds-db:connect` IAM inline policy to all 5 roles (ecsTaskRole, discoveryTaskRole, schedulerLambdaRole, vectorProcessorRole, kbSyncProcessorRole)
- Exported `postgresEndpoint` and `databaseUrl` as stack outputs
- Added `dbPassword` setup comment to `Pulumi.prod.yaml`

## Deployment

```bash
# Set the password secret (one-time)
cd infra/compute && pulumi config set --secret dbPassword "your-password-here" --stack prod

# Deploy
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod
```

RDS provisioning takes ~5-10 minutes on first deploy.

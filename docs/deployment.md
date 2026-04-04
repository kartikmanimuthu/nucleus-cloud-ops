# Deployment Guide

> For the full deployment reference, see [`infra/DEPLOYMENT.md`](../infra/DEPLOYMENT.md).

## Prerequisites

- AWS CLI with `PLATFORM-ADMIN` profile configured
- Docker (for building WebUI container images)
- Node.js 20+ and npm
- Pulumi CLI (`brew install pulumi`)

## Deploy Infrastructure (Pulumi)

```bash
# Install deps (required after fresh clone)
cd infra/networking && npm install && pulumi install
cd infra/compute && npm install && pulumi install

# Deploy — networking first, then compute
# pulumi up auto-builds lambdas + Docker image when source changes
cd infra/networking && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

## Authenticate Docker with ECR

Required before the first `pulumi up` on a fresh machine:

```bash
# ECR Private (for pushing built images)
AWS_PROFILE=PLATFORM-ADMIN aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin \
    970547372609.dkr.ecr.us-east-1.amazonaws.com

# ECR Public (for pulling base images like node:20.9.0-slim)
AWS_PROFILE=PLATFORM-ADMIN aws ecr-public get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin public.ecr.aws
docker pull public.ecr.aws/docker/library/node:20.9.0-slim
```

## Clean Up Local Port

```bash
kill -9 $(lsof -t -i:3000 -sTCP:LISTEN)
```

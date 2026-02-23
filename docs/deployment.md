# Deployment Guide

This document outlines the standard deployment process for the AI Ops application.

## Prerequisites

Ensure you have the following installed and configured:
- AWS CLI with the `YOUR_AWS_PROFILE` profile configured.
- Docker for building container images.
- Node.js & npm (for deploying the AWS CDK application).
- Python 3.

## Step 1: Authenticate Docker with AWS ECR Public

Before deploying, authenticate your local Docker client to the public Amazon Elastic Container Registry (ECR). The CDK stack or local runners may require pushing or pulling images.

```bash
AWS_PROFILE=YOUR_AWS_PROFILE aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws
```

## Step 2: Configure Docker Buildx

To avoid compatibility issues or unnecessary attestations in the built Docker images, disable the default attestations:

```bash
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
```

## Step 3: Deploy AWS Infrastructure

Deploy the AWS CDK application across all defined stacks. The `--require-approval never` flag is used to bypass interactive prompts for IAM and security group changes.

```bash
AWS_PROFILE=YOUR_AWS_PROFILE npx cdk deploy --all --require-approval never
```

## Step 4: Clean Up Local Environment

Ensure there are no conflicting local development servers or rogue UI processes running on port 3000 before starting new local services.

```bash
kill -9 $(lsof -t -i:3000 -sTCP:LISTEN)
```


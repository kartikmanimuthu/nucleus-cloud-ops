# AWS CodePipeline CI/CD for Nucleus Cloud Ops — Design Spec

**Date:** 2026-05-02
**Branch:** `ci-cd`
**Scope:** AWS CodePipeline that deploys the `infra/networking` and `infra/compute` Pulumi stacks on every merge to `master-v1`.

---

## 1. Goals

- Replace manual `pulumi up --stack prod` with an automated pipeline triggered by GitHub pushes.
- Run tests, lint, and `pulumi preview` before any infrastructure changes.
- Require manual human approval before the actual `pulumi up` deploy.
- Keep all CI/CD resources in the same AWS account (`ap-south-1`) with least-privilege IAM.

## 2. Architecture

A single **AWS CodePipeline** (`nucleus-cloud-ops-pipeline`) with five stages:

| Stage | Action | Purpose |
|-------|--------|---------|
| **Source** | CodeStar Connections (GitHub v2) | Poll `kartikmanimuthu/nucleus-cloud-ops` branch `master-v1` |
| **Build** | CodeBuild `nucleus-build` | Install deps, compile, run tests |
| **Preview** | CodeBuild `nucleus-preview` | `pulumi preview --stack prod` for networking + compute |
| **Approval** | Manual approval action | Human click in AWS Console / CLI |
| **Deploy** | CodeBuild `nucleus-deploy` | `pulumi up --stack prod --yes` for networking, then compute |

### 2.1 GitHub Integration

- **CodeStar Connection** (`nucleus-cloud-ops-connection`) — created by Pulumi (`aws.codestarconnections.Connection`) with `providerType: "GitHub"`.
- The connection ARN is exported as a Pulumi stack output and referenced in the pipeline source stage.
- **Important:** CodeStar Connections require a one-time OAuth handshake that cannot be automated. After `pulumi up` creates the connection in **PENDING** state, the user must click **"Update pending connection"** in the AWS Console and authenticate with GitHub. No personal access tokens are needed.

### 2.2 Artifact Flow

1. Source stage pulls code and outputs a ZIP artifact to S3.
2. Build stage consumes the ZIP, runs install + test, outputs a new artifact.
3. Preview stage consumes the build artifact, runs `pulumi preview`.
4. Deploy stage consumes the build artifact, runs `pulumi up`.

### 2.3 Pulumi State & Secrets

- **State backend:** already exists (`s3://nucleus-pulumi-state?region=us-east-1&awssdk=v2`). No changes.
- **Secrets provider:** compute stack uses passphrase with empty string (`PULUMI_CONFIG_PASSPHRASE=""`).
  - Set as plain-text env var in CodeBuild — not a Secrets Manager secret because the value is intentionally empty.
- **AWS region:** `ap-south-1` (set in `Pulumi.<stack>.yaml` config, not overridden in pipeline).

## 3. CodeBuild Projects

All use `BUILD_GENERAL1_MEDIUM` (3 GB / 2 vCPU) except `nucleus-deploy` which uses `BUILD_GENERAL1_LARGE` (7 GB / 4 vCPU) because Docker image builds during `pulumi up` are memory-heavy.

### 3.1 `nucleus-build`

```yaml
# infra/cicd/buildspec-build.yml
version: 0.2
phases:
  install:
    runtime-versions:
      nodejs: 20
    commands:
      - npm install -g pulumi@3.228.0
      - npm install
      - cd web-ui && npm install && cd ..
      - cd workers && npm install && cd ..
      - cd infra/networking && npm install && pulumi install && cd ../..
      - cd infra/compute && npm install && pulumi install && cd ../..
  build:
    commands:
      - npm run build
      - cd web-ui && npm run test && cd ..
      - cd workers && npm run test && cd ..
      - cd lambda/scheduler && npm run test && cd ../..
artifacts:
  files: '**/*'
  name: build-output-$(date +%Y%m%d-%H%M%S)
```

### 3.2 `nucleus-preview`

```yaml
# infra/cicd/buildspec-preview.yml
version: 0.2
env:
  variables:
    PULUMI_CONFIG_PASSPHRASE: ""
phases:
  build:
    commands:
      - cd infra/networking && pulumi preview --stack prod --non-interactive --diff
      - cd ../compute && pulumi preview --stack prod --non-interactive --diff
```

### 3.3 `nucleus-deploy`

```yaml
# infra/cicd/buildspec-deploy.yml
version: 0.2
env:
  variables:
    PULUMI_CONFIG_PASSPHRASE: ""
phases:
  build:
    commands:
      - cd infra/networking && pulumi up --stack prod --yes --non-interactive
      - cd ../compute && pulumi up --stack prod --yes --non-interactive
```

## 4. IAM Role (`CodePipelineRole`)

A single IAM role attached to CodePipeline and assumed by CodeBuild.

### 4.1 Trust Policy

- `codepipeline.amazonaws.com`
- `codebuild.amazonaws.com`

### 4.2 Managed / Inline Policies

| Policy | Purpose |
|--------|---------|
| `codepipeline:*` (scoped to pipeline ARN) | Pipeline management |
| `codestar-connections:UseConnection` | GitHub v2 source action |
| `codebuild:StartBuild`, `codebuild:BatchGetBuilds`, `codebuild:BatchGetReports` | Trigger and monitor builds |
| `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` | Artifact bucket read/write |
| `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` | CloudWatch Logs for CodeBuild |
| `kms:Decrypt`, `kms:GenerateDataKey` | Artifact bucket SSE-KMS |
| Broad AWS service permissions (EC2, ECS, Lambda, RDS, IAM, CloudFront, Cognito, VPC, etc.) | Pulumi needs these to create/update resources. Use the existing `PLATFORM-ADMIN` policy or a scoped custom policy that mirrors Pulumi stack resource types. |

### 4.3 Scoped Pulumi Permissions (Recommended)

Instead of attaching the full `PLATFORM-ADMIN` policy, create a custom policy that allows only the resource types created by the two stacks:

- `ec2:*` (VPC, subnets, security groups, bastion)
- `ecs:*` (cluster, service, task definition)
- `lambda:*` (functions, layers, permissions)
- `rds:*` (instance, subnet groups, parameter groups)
- `cognito-idp:*`, `cognito-identity:*`
- `cloudfront:*`
- `iam:*` (roles, policies, instance profiles — careful with `iam:*`)
- `s3:*` (buckets, bucket policies)
- `secretsmanager:*` (read/update secrets)
- `sqs:*`, `events:*` (EventBridge, SQS)
- `logs:*` (CloudWatch log groups)
- `acm:*` (certificates)
- `elasticloadbalancing:*` (ALB)
- `ecr:*` (repositories, images)
- `ssm:*` (Session Manager)
- `sns:*` (notifications)
- `route53:*` (DNS)
- `kms:*` (key usage)
- `autoscaling:*` (ECS capacity provider)

**Note:** `iam:*` is broad. If the Pulumi stack only creates specific roles, scope `iam:CreateRole`, `iam:DeleteRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:DetachRolePolicy`, `iam:PassRole` to resource-level conditions matching `arn:aws:iam::<account>:role/nucleus-*`.

## 5. Error Handling & Rollback

| Scenario | Behavior |
|----------|----------|
| **Build stage fails** (test/lint/compile) | Pipeline stops. Fix code → merge new PR → pipeline restarts. |
| **Preview stage fails** | Pipeline stops before manual approval. Developer checks CloudWatch logs for `pulumi preview` output. |
| **Manual approval rejected** | Pipeline stops. No infrastructure changes. |
| **Deploy (networking) fails** | Pipeline stops. Networking may be partially updated. Manual recovery with `pulumi up` or revert commit + re-run pipeline. |
| **Deploy (compute) fails** | Networking already updated; compute partially updated. `git revert HEAD` + re-run pipeline, or manual Pulumi state operations. |
| **ECS rollout fails during compute deploy** | Pulumi reports failure. ECS auto-rollback to last stable task definition. Pipeline fails. |

### 5.1 Notification on Failure

Optional: add an SNS topic `nucleus-pipeline-notifications` subscribed to an email address or Slack webhook. CodePipeline triggers SNS on `PIPELINE_EXECUTION_FAILED` via EventBridge rule.

## 6. Bootstrap (One-Time Setup)

Two options for creating the pipeline resources:

### Option A — Pulumi Stack (Recommended)

Create `infra/cicd/` as a new Pulumi stack that defines:
- CodeStar Connection
- S3 artifact bucket + KMS key
- IAM role + policies
- CodeBuild projects
- CodePipeline
- SNS topic (optional)

Benefit: infrastructure-as-code, tracked in Git, can be updated via `pulumi up`.

### Option B — CloudFormation Template

A single CloudFormation template `infra/cicd/cicd-stack.yaml` that creates the same resources. Good if you want a quick one-click deploy from AWS Console.

**Decision:** Use **Option A (Pulumi stack)** for consistency with the rest of the project.

## 7. File Structure

```
infra/
├── cicd/
│   ├── Pulumi.yaml
│   ├── Pulumi.prod.yaml
│   ├── index.ts              # Pipeline, CodeBuild, IAM, S3, KMS, SNS resources
│   ├── buildspec-build.yml
│   ├── buildspec-preview.yml
│   ├── buildspec-deploy.yml
│   └── README.md
├── networking/
├── compute/
└── ...
```

## 8. Environment Variables in CodeBuild

| Variable | Value | Set In |
|----------|-------|--------|
| `PULUMI_CONFIG_PASSPHRASE` | `""` (empty string) | Buildspec env (plain text) |
| `AWS_REGION` | `ap-south-1` | Buildspec env or Pulumi config |
| `AWS_DEFAULT_REGION` | `ap-south-1` | Buildspec env |
| `NODE_OPTIONS` | `--max-old-space-size=4096` | Buildspec env (for heavy Next.js builds) |

No secrets (NEXTAUTH_SECRET, DATABASE_URL) are needed in the pipeline — those are managed by Pulumi and AWS Secrets Manager, not by CodeBuild.

## 9. Manual Approval Details

- **Approver type:** IAM user or IAM role with `codepipeline:PutApprovalResult` on the pipeline.
- **Approval timeout:** 7 days (default). After 7 days, the pipeline fails.
- **Approval message:** `"Review Pulumi preview output in CloudWatch Logs before approving."`
- **How to approve:** AWS Console → CodePipeline → pipeline → "Review" button, or AWS CLI:
  ```bash
  aws codepipeline put-approval-result \
    --pipeline-name nucleus-cloud-ops-pipeline \
    --stage-name Deploy \
    --action-name ApproveDeploy \
    --result summary="Approved",status=Approved
  ```

## 10. Post-Deploy Verification (Optional)

Add a sixth stage to the pipeline after Deploy:

| Stage | Action | Purpose |
|-------|--------|---------|
| **Smoke Test** | CodeBuild `nucleus-smoke-test` | `npx playwright test tests/e2e/ --project=chromium` against the CloudFront URL |

**Decision:** Deferred to Phase 2. The pipeline starts with 4 stages; smoke test can be added later.

## 11. Cost Estimate (Monthly, ap-south-1)

| Resource | Estimate |
|----------|----------|
| CodePipeline (1 pipeline, ~20 executions/month) | ~$2 |
| CodeBuild `nucleus-build` (MEDIUM, ~15 min/exec) | ~$4 |
| CodeBuild `nucleus-preview` (MEDIUM, ~5 min/exec) | ~$2 |
| CodeBuild `nucleus-deploy` (LARGE, ~20 min/exec) | ~$12 |
| S3 artifact storage (~100 MB × 20 builds) | ~$0.10 |
| KMS key (1 CMK) | ~$1 |
| **Total** | **~$21/month** |

## 12. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Pulumi preview shows no changes but deploy still runs | Expected — networking is usually a no-op. Acceptable cost. |
| Docker build in ECS image times out | Use `BUILD_GENERAL1_LARGE` for deploy; increase CodeBuild timeout to 60 min. |
| IAM role lacks permission for new resource type | Pipeline fails with clear AWS error. Add permission to IAM policy, re-run. |
| Manual approval forgotten for days | 7-day timeout auto-fails pipeline. EventBridge + SNS can alert. |
| GitHub connection breaks (OAuth token revoked) | Re-authenticate in AWS Console CodeStar Connections page. |

## 13. Open Questions

None — all decisions resolved during brainstorming.

# Nucleus Cloud Ops — CI/CD Pipeline

AWS CodePipeline that builds, previews, and deploys the Pulumi infrastructure on every push to `master-v1`.

## Architecture

| Stage | Action | Purpose |
|-------|--------|---------|
| Source | CodeStar Connection (GitHub v2) | Poll `kartikmanimuthu/nucleus-cloud-ops` branch `master-v1` |
| Build | CodeBuild `nucleus-build` | Install deps, compile, run tests |
| Preview | CodeBuild `nucleus-preview` | `pulumi preview --stack prod` for networking + compute |
| Approval | Manual approval | Human click in AWS Console before deploy |
| Deploy | CodeBuild `nucleus-deploy` | `pulumi up --stack prod --yes` for networking, then compute |

## One-Time Bootstrap

### 1. Create GitHub CodeStar Connection (AWS Console)

1. Go to **AWS Console → Developer Tools → CodeStar Connections → Create connection**
2. Select **GitHub** → **Connect to GitHub**
3. Authenticate with your GitHub account (OAuth popup)
4. Select the repository: `kartikmanimuthu/nucleus-cloud-ops`
5. Name the connection: `nucleus-cloud-ops-connection`
6. Copy the **Connection ARN** — looks like:
   ```
   arn:aws:codestar-connections:ap-south-1:123456789012:connection/abcd1234-efgh-5678-ijkl-9012mnop3456
   ```

> **Note:** CodeStar Connections cannot be created via Pulumi/CloudFormation — the OAuth handshake must be done manually.

### 2. Set Pulumi Config

```bash
cd infra/cicd
pulumi stack init prod
pulumi config set aws:region ap-south-1
pulumi config set githubConnectionArn "arn:aws:codestar-connections:ap-south-1:YOUR_ACCOUNT_ID:connection/YOUR_CONNECTION_ID"
```

### 3. Install Dependencies and Deploy

```bash
cd infra/cicd
npm install && pulumi install
AWS_PROFILE=PLATFORM-ADMIN pulumi up --stack prod --yes
```

### 4. Verify the Pipeline

1. Go to **AWS Console → CodePipeline → Pipelines → nucleus-cloud-ops-pipeline**
2. The pipeline should show the 5 stages: Source, Build, Preview, Approval, Deploy
3. Trigger the first run by making a commit to `master-v1` or clicking "Release change"

### 5. Approve the First Deploy

When the pipeline reaches the **Approval** stage:
1. Click **Review** in the AWS Console
2. Enter an approval comment
3. Click **Approve**
4. The Deploy stage runs `pulumi up --stack prod --yes` for both networking and compute

## Day-to-Day Usage

### Trigger a Pipeline Run

Any push to `master-v1` automatically triggers the pipeline (GitHub webhook via CodeStar Connection).

### Manual Trigger

```bash
aws codepipeline start-pipeline-execution --name nucleus-cloud-ops-pipeline --region ap-south-1
```

### Approve via CLI

```bash
aws codepipeline put-approval-result \
  --pipeline-name nucleus-cloud-ops-pipeline \
  --stage-name Approval \
  --action-name ApproveDeploy \
  --result summary="Approved",status=Approved \
  --region ap-south-1
```

### View Build Logs

```bash
# Build stage
aws logs tail /aws/codebuild/nucleus-cloud-ops-build --follow --region ap-south-1

# Preview stage
aws logs tail /aws/codebuild/nucleus-cloud-ops-preview --follow --region ap-south-1

# Deploy stage
aws logs tail /aws/codebuild/nucleus-cloud-ops-deploy --follow --region ap-south-1
```

## Pipeline Failure Scenarios

| Failure | Action |
|---------|--------|
| Build fails | Fix code, merge to `master-v1`, pipeline auto-restarts |
| Preview fails | Check CloudWatch logs for `pulumi preview` error |
| Approval rejected | No deploy happens. Fix code, merge, pipeline restarts |
| Deploy fails | Check CloudWatch logs. May need manual `pulumi up` recovery |

## Cost

~$21/month for ~20 executions (ap-south-1 pricing).

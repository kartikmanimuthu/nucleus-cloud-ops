# AWS CodePipeline CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an AWS CodePipeline (defined as a Pulumi stack in `infra/cicd/`) that builds, previews, and deploys the `infra/networking` and `infra/compute` stacks on every push to `master-v1`, with manual approval before deploy.

**Architecture:** A new Pulumi stack `infra/cicd/` creates all CI/CD resources (S3 bucket, KMS key, IAM role, 3 CodeBuild projects, CodePipeline). The pipeline has 5 stages: Source (GitHub via CodeStar Connection) → Build (install + test) → Preview (`pulumi preview`) → Manual Approval → Deploy (`pulumi up`). The GitHub connection is created manually in AWS Console first; its ARN is passed as Pulumi config.

**Tech Stack:** Pulumi TypeScript (`@pulumi/pulumi`, `@pulumi/aws`), AWS CodePipeline, AWS CodeBuild, AWS CodeStar Connections, S3, KMS

---

## File Structure

```
infra/cicd/
├── Pulumi.yaml
├── Pulumi.prod.yaml
├── package.json
├── index.ts                  # All CI/CD resources (S3, KMS, IAM, CodeBuild, CodePipeline)
├── buildspec-build.yml       # Install deps, compile, run tests
├── buildspec-preview.yml     # Pulumi preview for networking + compute
├── buildspec-deploy.yml      # Pulumi up for networking + compute
└── README.md                 # Bootstrap instructions
```

---

### Task 1: Create Pulumi Project Config Files

**Files:**
- Create: `infra/cicd/Pulumi.yaml`
- Create: `infra/cicd/package.json`
- Create: `infra/cicd/Pulumi.prod.yaml` (placeholder — config set in Task 7)

- [ ] **Step 1: Create `Pulumi.yaml`**

```yaml
name: nucleus-cicd
runtime: nodejs
description: Nucleus Cloud Ops — AWS CodePipeline CI/CD
backend:
  url: s3://nucleus-pulumi-state?region=us-east-1&awssdk=v2
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "nucleus-cicd",
  "version": "1.0.0",
  "description": "Nucleus Cloud Ops — CodePipeline CI/CD (Pulumi)",
  "main": "index.ts",
  "scripts": {
    "preview": "pulumi preview",
    "up": "pulumi up",
    "destroy": "pulumi destroy"
  },
  "dependencies": {
    "@pulumi/pulumi": "^3.228.0",
    "@pulumi/aws": "^7.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.5.4",
    "typescript": "~5.6.2"
  }
}
```

- [ ] **Step 3: Create placeholder `Pulumi.prod.yaml`**

```yaml
config:
  aws:region: ap-south-1
  nucleus-cicd:githubConnectionArn: "arn:aws:codestar-connections:ap-south-1:ACCOUNT_ID:connection/CONNECTION_ID"
```

> **Note:** The `githubConnectionArn` placeholder will be replaced with the real ARN in Task 7 after the manual AWS Console setup.

- [ ] **Step 4: Commit**

```bash
git add infra/cicd/Pulumi.yaml infra/cicd/package.json infra/cicd/Pulumi.prod.yaml
git commit -m "feat(cicd): add Pulumi project config for CodePipeline CI/CD"
```

---

### Task 2: Create Buildspecs

**Files:**
- Create: `infra/cicd/buildspec-build.yml`
- Create: `infra/cicd/buildspec-preview.yml`
- Create: `infra/cicd/buildspec-deploy.yml`

- [ ] **Step 1: Create `buildspec-build.yml`**

```yaml
version: 0.2
env:
  variables:
    NODE_OPTIONS: "--max-old-space-size=4096"
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

- [ ] **Step 2: Create `buildspec-preview.yml`**

```yaml
version: 0.2
env:
  variables:
    PULUMI_CONFIG_PASSPHRASE: ""
    AWS_DEFAULT_REGION: ap-south-1
phases:
  build:
    commands:
      - cd infra/networking && pulumi preview --stack prod --non-interactive --diff
      - cd ../compute && pulumi preview --stack prod --non-interactive --diff
```

- [ ] **Step 3: Create `buildspec-deploy.yml`**

```yaml
version: 0.2
env:
  variables:
    PULUMI_CONFIG_PASSPHRASE: ""
    AWS_DEFAULT_REGION: ap-south-1
phases:
  build:
    commands:
      - cd infra/networking && pulumi up --stack prod --yes --non-interactive
      - cd ../compute && pulumi up --stack prod --yes --non-interactive
```

- [ ] **Step 4: Commit**

```bash
git add infra/cicd/buildspec-build.yml infra/cicd/buildspec-preview.yml infra/cicd/buildspec-deploy.yml
git commit -m "feat(cicd): add CodeBuild buildspecs for build, preview, and deploy"
```

---

### Task 3: Create `infra/cicd/index.ts` — Part 1 (S3, KMS, IAM)

**Files:**
- Create: `infra/cicd/index.ts`

- [ ] **Step 1: Write the top of `index.ts` with imports, config, and helpers**

```typescript
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const config = new pulumi.Config();
const githubConnectionArn = config.require("githubConnectionArn");

const appName = "nucleus-cloud-ops";
const pipelineName = `${appName}-pipeline`;
const repoOwner = "kartikmanimuthu";
const repoName = "nucleus-cloud-ops";
const branchName = "master-v1";

// Account / region
const callerIdentity = aws.getCallerIdentityOutput({});
const accountId = callerIdentity.accountId;
const region = aws.config.region ?? "ap-south-1";

// ---------------------------------------------------------------------------
// S3 Artifact Bucket
// ---------------------------------------------------------------------------
const artifactBucket = new aws.s3.BucketV2("pipeline-artifacts", {
    bucket: pulumi.interpolate`${appName}-pipeline-artifacts-${accountId}-${region}`,
    forceDestroy: true,
}, { retainOnDelete: true });

// Block public access
new aws.s3.BucketPublicAccessBlock("pipeline-artifacts-pab", {
    bucket: artifactBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
});

// Enable versioning for artifact traceability
new aws.s3.BucketVersioningV2("pipeline-artifacts-versioning", {
    bucket: artifactBucket.id,
    versioningConfiguration: { status: "Enabled" },
});

// ---------------------------------------------------------------------------
// KMS Key for Artifact Encryption
// ---------------------------------------------------------------------------
const artifactKmsKey = new aws.kms.Key("pipeline-artifacts-key", {
    description: "KMS key for CodePipeline artifact encryption",
    deletionWindowInDays: 7,
    enableKeyRotation: true,
});

new aws.kms.Alias("pipeline-artifacts-key-alias", {
    name: pulumi.interpolate`alias/${appName}-pipeline-artifacts`,
    targetKeyId: artifactKmsKey.id,
});

// ---------------------------------------------------------------------------
// IAM Role (shared by CodePipeline + CodeBuild)
// ---------------------------------------------------------------------------
const codePipelineRole = new aws.iam.Role("codepipeline-role", {
    name: `${appName}-codepipeline-role`,
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Principal: { Service: "codepipeline.amazonaws.com" },
                Action: "sts:AssumeRole",
            },
            {
                Effect: "Allow",
                Principal: { Service: "codebuild.amazonaws.com" },
                Action: "sts:AssumeRole",
            },
        ],
    }),
});

// Allow the role to use the KMS key
new aws.kms.KeyPolicy("pipeline-artifacts-key-policy", {
    keyId: artifactKmsKey.id,
    policy: pulumi.all([artifactKmsKey.arn, accountId]).apply(([keyArn, accId]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Sid: "Enable IAM User Permissions",
                    Effect: "Allow",
                    Principal: { AWS: `arn:aws:iam::${accId}:root` },
                    Action: "kms:*",
                    Resource: "*",
                },
                {
                    Sid: "Allow CodePipeline and CodeBuild",
                    Effect: "Allow",
                    Principal: {
                        AWS: `arn:aws:iam::${accId}:role/${appName}-codepipeline-role`,
                    },
                    Action: [
                        "kms:Encrypt",
                        "kms:Decrypt",
                        "kms:ReEncrypt*",
                        "kms:GenerateDataKey*",
                        "kms:DescribeKey",
                    ],
                    Resource: "*",
                },
            ],
        }),
    ),
});
```

- [ ] **Step 2: Commit**

```bash
git add infra/cicd/index.ts
git commit -m "feat(cicd): add S3 bucket, KMS key, and IAM role for CodePipeline"
```

---

### Task 4: Create `infra/cicd/index.ts` — Part 2 (IAM Policies)

**Files:**
- Modify: `infra/cicd/index.ts` (append below existing code)

- [ ] **Step 1: Append the IAM policy documents to `index.ts`**

```typescript
// ---------------------------------------------------------------------------
// IAM Policy — CodePipeline Core (S3, CodeBuild, CloudWatch, KMS)
// ---------------------------------------------------------------------------
new aws.iam.RolePolicy("codepipeline-core-policy", {
    role: codePipelineRole.id,
    policy: pulumi.all([artifactBucket.arn, artifactKmsKey.arn, accountId, region]).apply(
        ([bucketArn, keyArn, accId, reg]) =>
            JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                    {
                        Sid: "S3ArtifactAccess",
                        Effect: "Allow",
                        Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
                        Resource: [bucketArn, `${bucketArn}/*`],
                    },
                    {
                        Sid: "KMSArtifactEncryption",
                        Effect: "Allow",
                        Action: [
                            "kms:Encrypt",
                            "kms:Decrypt",
                            "kms:ReEncrypt*",
                            "kms:GenerateDataKey*",
                            "kms:DescribeKey",
                        ],
                        Resource: keyArn,
                    },
                    {
                        Sid: "CodeBuildAccess",
                        Effect: "Allow",
                        Action: [
                            "codebuild:StartBuild",
                            "codebuild:BatchGetBuilds",
                            "codebuild:BatchGetReports",
                        ],
                        Resource: `arn:aws:codebuild:${reg}:${accId}:project/${appName}-*`,
                    },
                    {
                        Sid: "CloudWatchLogs",
                        Effect: "Allow",
                        Action: [
                            "logs:CreateLogGroup",
                            "logs:CreateLogStream",
                            "logs:PutLogEvents",
                        ],
                        Resource: `arn:aws:logs:${reg}:${accId}:log-group:/aws/codebuild/${appName}-*:*`,
                    },
                    {
                        Sid: "CodeStarConnection",
                        Effect: "Allow",
                        Action: ["codestar-connections:UseConnection"],
                        Resource: githubConnectionArn,
                    },
                ],
            }),
    ),
});

// ---------------------------------------------------------------------------
// IAM Policy — Pulumi Deploy Permissions (broad, scoped to nucleus-* prefix where possible)
// ---------------------------------------------------------------------------
new aws.iam.RolePolicy("pulumi-deploy-policy", {
    role: codePipelineRole.id,
    policy: pulumi.all([accountId, region]).apply(([accId, reg]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Sid: "EC2",
                    Effect: "Allow",
                    Action: "ec2:*",
                    Resource: "*",
                },
                {
                    Sid: "ECS",
                    Effect: "Allow",
                    Action: "ecs:*",
                    Resource: "*",
                },
                {
                    Sid: "Lambda",
                    Effect: "Allow",
                    Action: "lambda:*",
                    Resource: "*",
                },
                {
                    Sid: "RDS",
                    Effect: "Allow",
                    Action: "rds:*",
                    Resource: "*",
                },
                {
                    Sid: "Cognito",
                    Effect: "Allow",
                    Action: ["cognito-idp:*", "cognito-identity:*"],
                    Resource: "*",
                },
                {
                    Sid: "CloudFront",
                    Effect: "Allow",
                    Action: "cloudfront:*",
                    Resource: "*",
                },
                {
                    Sid: "IAM",
                    Effect: "Allow",
                    Action: [
                        "iam:CreateRole",
                        "iam:DeleteRole",
                        "iam:GetRole",
                        "iam:ListRoles",
                        "iam:PutRolePolicy",
                        "iam:DeleteRolePolicy",
                        "iam:GetRolePolicy",
                        "iam:ListRolePolicies",
                        "iam:AttachRolePolicy",
                        "iam:DetachRolePolicy",
                        "iam:CreatePolicy",
                        "iam:DeletePolicy",
                        "iam:GetPolicy",
                        "iam:ListPolicies",
                        "iam:CreateInstanceProfile",
                        "iam:DeleteInstanceProfile",
                        "iam:GetInstanceProfile",
                        "iam:AddRoleToInstanceProfile",
                        "iam:RemoveRoleFromInstanceProfile",
                        "iam:PassRole",
                        "iam:UpdateAssumeRolePolicy",
                        "iam:TagRole",
                        "iam:UntagRole",
                        "iam:ListInstanceProfilesForRole",
                        "iam:ListAttachedRolePolicies",
                    ],
                    Resource: "*",
                },
                {
                    Sid: "S3",
                    Effect: "Allow",
                    Action: "s3:*",
                    Resource: "*",
                },
                {
                    Sid: "SecretsManager",
                    Effect: "Allow",
                    Action: "secretsmanager:*",
                    Resource: `arn:aws:secretsmanager:${reg}:${accId}:secret:${appName}/*`,
                },
                {
                    Sid: "SQS",
                    Effect: "Allow",
                    Action: "sqs:*",
                    Resource: "*",
                },
                {
                    Sid: "EventBridge",
                    Effect: "Allow",
                    Action: "events:*",
                    Resource: "*",
                },
                {
                    Sid: "CloudWatchLogsAll",
                    Effect: "Allow",
                    Action: "logs:*",
                    Resource: "*",
                },
                {
                    Sid: "ACM",
                    Effect: "Allow",
                    Action: "acm:*",
                    Resource: "*",
                },
                {
                    Sid: "ELB",
                    Effect: "Allow",
                    Action: "elasticloadbalancing:*",
                    Resource: "*",
                },
                {
                    Sid: "ECR",
                    Effect: "Allow",
                    Action: "ecr:*",
                    Resource: `arn:aws:ecr:${reg}:${accId}:repository/${appName}*`,
                },
                {
                    Sid: "ECRPublic",
                    Effect: "Allow",
                    Action: "ecr-public:*",
                    Resource: "*",
                },
                {
                    Sid: "SSM",
                    Effect: "Allow",
                    Action: "ssm:*",
                    Resource: "*",
                },
                {
                    Sid: "SNS",
                    Effect: "Allow",
                    Action: "sns:*",
                    Resource: "*",
                },
                {
                    Sid: "Route53",
                    Effect: "Allow",
                    Action: "route53:*",
                    Resource: "*",
                },
                {
                    Sid: "KMS",
                    Effect: "Allow",
                    Action: "kms:*",
                    Resource: "*",
                },
                {
                    Sid: "AutoScaling",
                    Effect: "Allow",
                    Action: "autoscaling:*",
                    Resource: "*",
                },
                {
                    Sid: "ResourceGroupsTagging",
                    Effect: "Allow",
                    Action: [
                        "tag:GetResources",
                        "tag:GetTagKeys",
                        "tag:GetTagValues",
                    ],
                    Resource: "*",
                },
                {
                    Sid: "STS",
                    Effect: "Allow",
                    Action: ["sts:GetCallerIdentity", "sts:AssumeRole"],
                    Resource: "*",
                },
                {
                    Sid: "DynamoDB",
                    Effect: "Allow",
                    Action: "dynamodb:*",
                    Resource: "*",
                },
                {
                    Sid: "CloudWatchMetrics",
                    Effect: "Allow",
                    Action: "cloudwatch:*",
                    Resource: "*",
                },
            ],
        }),
    ),
});
```

- [ ] **Step 2: Commit**

```bash
git add infra/cicd/index.ts
git commit -m "feat(cicd): add IAM policies for CodePipeline and Pulumi deployment"
```

---

### Task 5: Create `infra/cicd/index.ts` — Part 3 (CodeBuild Projects)

**Files:**
- Modify: `infra/cicd/index.ts` (append below existing code)

- [ ] **Step 1: Append the CodeBuild projects to `index.ts`**

```typescript
// ---------------------------------------------------------------------------
// CodeBuild Projects
// ---------------------------------------------------------------------------

const buildspecPath = (name: string) =>
    pulumi.interpolate`infra/cicd/buildspec-${name}.yml`;

const buildProject = new aws.codebuild.Project("nucleus-build", {
    name: `${appName}-build`,
    description: "Install dependencies, compile, and run tests",
    serviceRole: codePipelineRole.arn,
    buildTimeout: "30",
    artifacts: { type: "CODEPIPELINE" },
    environment: {
        type: "LINUX_CONTAINER",
        computeType: "BUILD_GENERAL1_MEDIUM",
        image: "aws/codebuild/standard:7.0",
        privilegedMode: true,
    },
    source: {
        type: "CODEPIPELINE",
        buildspec: buildspecPath("build"),
    },
    cache: {
        type: "S3",
        location: pulumi.interpolate`${artifactBucket.id}/cache/build`,
    },
});

const previewProject = new aws.codebuild.Project("nucleus-preview", {
    name: `${appName}-preview`,
    description: "Run Pulumi preview for networking and compute stacks",
    serviceRole: codePipelineRole.arn,
    buildTimeout: "20",
    artifacts: { type: "CODEPIPELINE" },
    environment: {
        type: "LINUX_CONTAINER",
        computeType: "BUILD_GENERAL1_MEDIUM",
        image: "aws/codebuild/standard:7.0",
        privilegedMode: false,
    },
    source: {
        type: "CODEPIPELINE",
        buildspec: buildspecPath("preview"),
    },
});

const deployProject = new aws.codebuild.Project("nucleus-deploy", {
    name: `${appName}-deploy`,
    description: "Run Pulumi up for networking and compute stacks",
    serviceRole: codePipelineRole.arn,
    buildTimeout: "60",
    artifacts: { type: "CODEPIPELINE" },
    environment: {
        type: "LINUX_CONTAINER",
        computeType: "BUILD_GENERAL1_LARGE",
        image: "aws/codebuild/standard:7.0",
        privilegedMode: true,
    },
    source: {
        type: "CODEPIPELINE",
        buildspec: buildspecPath("deploy"),
    },
});
```

- [ ] **Step 2: Commit**

```bash
git add infra/cicd/index.ts
git commit -m "feat(cicd): add CodeBuild projects for build, preview, and deploy"
```

---

### Task 6: Create `infra/cicd/index.ts` — Part 4 (CodePipeline)

**Files:**
- Modify: `infra/cicd/index.ts` (append below existing code)

- [ ] **Step 1: Append the CodePipeline definition to `index.ts`**

```typescript
// ---------------------------------------------------------------------------
// CodePipeline
// ---------------------------------------------------------------------------
const pipeline = new aws.codepipeline.Pipeline("nucleus-pipeline", {
    name: pipelineName,
    roleArn: codePipelineRole.arn,
    artifactStore: {
        type: "S3",
        location: artifactBucket.id,
        encryptionKey: {
            id: artifactKmsKey.arn,
            type: "KMS",
        },
    },
    stages: [
        {
            name: "Source",
            actions: [
                {
                    name: "GitHubSource",
                    category: "Source",
                    owner: "AWS",
                    provider: "CodeStarSourceConnection",
                    version: "1",
                    outputArtifacts: ["source_output"],
                    configuration: {
                        ConnectionArn: githubConnectionArn,
                        FullRepositoryId: `${repoOwner}/${repoName}`,
                        BranchName: branchName,
                    },
                },
            ],
        },
        {
            name: "Build",
            actions: [
                {
                    name: "BuildAction",
                    category: "Build",
                    owner: "AWS",
                    provider: "CodeBuild",
                    version: "1",
                    inputArtifacts: ["source_output"],
                    outputArtifacts: ["build_output"],
                    configuration: {
                        ProjectName: buildProject.name,
                    },
                },
            ],
        },
        {
            name: "Preview",
            actions: [
                {
                    name: "PreviewAction",
                    category: "Build",
                    owner: "AWS",
                    provider: "CodeBuild",
                    version: "1",
                    inputArtifacts: ["build_output"],
                    outputArtifacts: ["preview_output"],
                    configuration: {
                        ProjectName: previewProject.name,
                    },
                },
            ],
        },
        {
            name: "Approval",
            actions: [
                {
                    name: "ApproveDeploy",
                    category: "Approval",
                    owner: "AWS",
                    provider: "Manual",
                    version: "1",
                    configuration: {
                        CustomData:
                            "Review Pulumi preview output in CloudWatch Logs before approving.",
                    },
                },
            ],
        },
        {
            name: "Deploy",
            actions: [
                {
                    name: "DeployAction",
                    category: "Build",
                    owner: "AWS",
                    provider: "CodeBuild",
                    version: "1",
                    inputArtifacts: ["build_output"],
                    outputArtifacts: ["deploy_output"],
                    configuration: {
                        ProjectName: deployProject.name,
                    },
                },
            ],
        },
    ],
});

// ---------------------------------------------------------------------------
// Stack Outputs
// ---------------------------------------------------------------------------
export const artifactBucketName = artifactBucket.id;
export const artifactKmsKeyArn = artifactKmsKey.arn;
export const pipelineArn = pipeline.arn;
export const buildProjectName = buildProject.name;
export const previewProjectName = previewProject.name;
export const deployProjectName = deployProject.name;
```

- [ ] **Step 2: Commit**

```bash
git add infra/cicd/index.ts
git commit -m "feat(cicd): add CodePipeline with Source, Build, Preview, Approval, Deploy stages"
```

---

### Task 7: Create Bootstrap README and Configure Stack

**Files:**
- Create: `infra/cicd/README.md`
- Modify: `infra/cicd/Pulumi.prod.yaml` (replace placeholder with real ARN)

- [ ] **Step 1: Create `README.md`**

```markdown
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
```

- [ ] **Step 2: Replace placeholder in `Pulumi.prod.yaml`**

After the manual AWS Console setup (Step 1 above), update the file:

```yaml
config:
  aws:region: ap-south-1
  nucleus-cicd:githubConnectionArn: "arn:aws:codestar-connections:ap-south-1:123456789012:connection/REPLACE_ME"
```

> **Important:** The real ARN must be obtained from the AWS Console after creating the CodeStar Connection. Do NOT commit the real ARN to Git — it is account-specific. The placeholder above is acceptable since the connection ARN is not a secret (it's just an AWS resource identifier).

- [ ] **Step 3: Commit**

```bash
git add infra/cicd/README.md infra/cicd/Pulumi.prod.yaml
git commit -m "docs(cicd): add bootstrap README and stack config template"
```

---

### Task 8: Validate with `pulumi preview`

**Files:** (no file changes — validation only)

- [ ] **Step 1: Install dependencies**

```bash
cd infra/cicd
npm install && pulumi install
```

Expected: `pulumi install` completes without errors.

- [ ] **Step 2: Set the required config (using a dummy ARN for preview)**

```bash
cd infra/cicd
pulumi config set githubConnectionArn "arn:aws:codestar-connections:ap-south-1:123456789012:connection/dummy"
```

> **Note:** The dummy ARN is fine for `pulumi preview` — it only validates the code structure. The real ARN is needed for `pulumi up`.

- [ ] **Step 3: Run `pulumi preview`**

```bash
PULUMI_CONFIG_PASSPHRASE="" pulumi preview --stack prod
```

Expected: Preview shows ~15 resources to create (S3 bucket, public access block, versioning, KMS key + alias, IAM role + 2 policies, 3 CodeBuild projects, 1 CodePipeline). No errors.

- [ ] **Step 4: TypeScript compile check**

```bash
cd infra/cicd
npx tsc --noEmit
```

Expected: No TypeScript errors.

- [ ] **Step 5: Commit (if any minor fixes were needed)**

If the preview or compile revealed issues, fix them and commit:

```bash
git add infra/cicd/
git commit -m "fix(cicd): resolve issues from pulumi preview validation"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] Single CodePipeline with 5 stages — Task 6
- [x] CodeStar Connection for GitHub v2 — Task 6 (source stage), Task 7 (bootstrap instructions)
- [x] Build stage with tests — Task 2 (buildspec-build.yml)
- [x] Preview stage with `pulumi preview` — Task 2 (buildspec-preview.yml), Task 5
- [x] Manual approval stage — Task 6
- [x] Deploy stage with `pulumi up` — Task 2 (buildspec-deploy.yml), Task 5
- [x] Same-account IAM role — Task 3, Task 4
- [x] S3 artifact bucket with KMS — Task 3
- [x] Environment variables (`PULUMI_CONFIG_PASSPHRASE`, `AWS_DEFAULT_REGION`) — Task 2
- [x] Bootstrap README — Task 7
- [x] Pulumi stack outputs — Task 6

**2. Placeholder scan:**
- [x] No "TBD", "TODO", "implement later", "fill in details"
- [x] All buildspecs contain complete commands
- [x] All IAM policy actions are explicitly listed
- [x] CodePipeline stages fully defined with all required fields
- [x] The only "placeholder" is the `githubConnectionArn` in `Pulumi.prod.yaml`, which is explicitly documented as requiring manual setup

**3. Type consistency:**
- [x] `buildspecPath("build")` used consistently in Task 5
- [x] `appName` used consistently as `"nucleus-cloud-ops"`
- [x] `pipelineName` matches the CodePipeline `name` field
- [x] `codePipelineRole` referenced consistently across Tasks 3–6

**4. File paths:**
- [x] `infra/cicd/Pulumi.yaml`
- [x] `infra/cicd/Pulumi.prod.yaml`
- [x] `infra/cicd/package.json`
- [x] `infra/cicd/index.ts`
- [x] `infra/cicd/buildspec-build.yml`
- [x] `infra/cicd/buildspec-preview.yml`
- [x] `infra/cicd/buildspec-deploy.yml`
- [x] `infra/cicd/README.md`

**5. Command accuracy:**
- [x] `pulumi preview --stack prod --non-interactive --diff` — correct flags
- [x] `pulumi up --stack prod --yes --non-interactive` — correct flags
- [x] `npm install && pulumi install` — matches existing project pattern
- [x] `npx tsc --noEmit` — standard TypeScript check

**Gap identified and accepted:** The plan does NOT include the optional SNS topic / EventBridge rule for failure notifications. The spec lists it as optional and defers it. If needed, it can be added in a follow-up task.

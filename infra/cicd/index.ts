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
    forceDestroy: false,
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
    policy: pulumi.all([artifactKmsKey.arn, accountId, codePipelineRole.arn]).apply(([keyArn, accId, roleArn]) =>
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
                        AWS: roleArn,
                    },
                    Action: [
                        "kms:Encrypt",
                        "kms:Decrypt",
                        "kms:ReEncrypt*",
                        "kms:GenerateDataKey*",
                        "kms:CreateGrant",
                        "kms:DescribeKey",
                    ],
                    Resource: "*",
                },
            ],
        }),
    ),
});

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
                    Sid: "ECRAuthToken",
                    Effect: "Allow",
                    Action: "ecr:GetAuthorizationToken",
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
                    Sid: "CloudWatchMetrics",
                    Effect: "Allow",
                    Action: "cloudwatch:*",
                    Resource: "*",
                },
            ],
        }),
    ),
});

// ---------------------------------------------------------------------------
// CodeBuild Projects
// ---------------------------------------------------------------------------

const buildspecPath = (name: string) =>
    pulumi.interpolate`infra/cicd/buildspec-${name}.yml`;

const buildProject = new aws.codebuild.Project("nucleus-build", {
    name: `${appName}-build`,
    description: "Install dependencies, compile, and run tests",
    serviceRole: codePipelineRole.arn,
    buildTimeout: 30,
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
    buildTimeout: 20,
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
    buildTimeout: 60,
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

// ---------------------------------------------------------------------------
// CodePipeline
// ---------------------------------------------------------------------------
const pipeline = new aws.codepipeline.Pipeline("nucleus-pipeline", {
    name: pipelineName,
    roleArn: codePipelineRole.arn,
    artifactStores: [{
        type: "S3",
        location: artifactBucket.id,
        encryptionKey: {
            id: artifactKmsKey.arn,
            type: "KMS",
        },
    }],
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


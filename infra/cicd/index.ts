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

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as random from "@pulumi/random";
import * as fs from "fs";
import * as path from "path";

// Account ID + region for resource name suffixes (no top-level await needed)
const callerIdentity = aws.getCallerIdentityOutput({});
const accountId = callerIdentity.accountId;
const region = aws.config.region ?? "us-east-1";

// Pulumi config
const config = new pulumi.Config();
const appUrl = config.get("appUrl") ?? "https://placeholder.cloudfront.net";
const subscriptionEmails = config.get("subscriptionEmails") ?? "";
const crossAccountRoleName = config.get("crossAccountRoleName") ?? "NucleusAccess";
const vectorBucketName = config.get("vectorBucketName") ?? "";
const discoveryImageUri = config.get("discoveryImageUri") ?? "";
const webUiImageUri = config.require("webUiImageUri");
const nextauthSecret = config.requireSecret("nextauthSecret");

// Phase 7+: Networking stack is deployed — use requireOutput() to enforce dependency.
// requireOutput() throws at preview time if networking stack is not deployed,
// preventing silent undefined values from propagating into compute resources.

// StackReference to networking project.
// Format for S3 backend: "organization/<project>/<stack>" (literal "organization" required)
const networking = new pulumi.StackReference("organization/nucleus-networking/prod");

// Networking outputs — all required (networking must be deployed before compute can preview)
const vpcId = networking.requireOutput("vpcId") as pulumi.Output<string>;
const vpcCidr = networking.requireOutput("vpcCidr") as pulumi.Output<string>;
const privateSubnetIds = networking.requireOutput("privateSubnetIds") as pulumi.Output<string[]>;
const publicSubnetIds = networking.requireOutput("publicSubnetIds") as pulumi.Output<string[]>;
const databaseSubnetIds = networking.requireOutput("databaseSubnetIds") as pulumi.Output<string[]>;
const intraSubnetIds = networking.requireOutput("intraSubnetIds") as pulumi.Output<string[]>;
const availabilityZones = networking.requireOutput("availabilityZones") as pulumi.Output<string[]>;
const dbSubnetGroupName = networking.requireOutput("dbSubnetGroupName") as pulumi.Output<string>;
const cacheSubnetGroupName = networking.requireOutput("cacheSubnetGroupName") as pulumi.Output<string>;

// ============================================================================
// DYNAMODB TABLES
// ============================================================================

const appName = "nucleus-cloud-ops";
const webUiStackName = "nucleus-cloud-ops-web-ui";

// 1. AppTable — single-table design (accounts, schedules, resources)
const appTable = new aws.dynamodb.Table("appTable", {
    name: "nucleus-cloud-ops-app-table",
    hashKey: "pk",
    rangeKey: "sk",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "pk", type: "S" },
        { name: "sk", type: "S" },
        { name: "gsi1pk", type: "S" },
        { name: "gsi1sk", type: "S" },
        { name: "gsi2pk", type: "S" },
        { name: "gsi2sk", type: "S" },
        { name: "gsi3pk", type: "S" },
        { name: "gsi3sk", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
    globalSecondaryIndexes: [
        {
            name: "GSI1",
            hashKey: "gsi1pk",
            rangeKey: "gsi1sk",
            projectionType: "ALL",
        },
        {
            name: "GSI2",
            hashKey: "gsi2pk",
            rangeKey: "gsi2sk",
            projectionType: "ALL",
        },
        {
            name: "GSI3",
            hashKey: "gsi3pk",
            rangeKey: "gsi3sk",
            projectionType: "ALL",
        },
    ],
}, { retainOnDelete: true });

// 2. AuditTable — immutable audit logs with 30-day TTL via expire_at
const auditTable = new aws.dynamodb.Table("auditTable", {
    name: "nucleus-cloud-ops-audit-table",
    hashKey: "pk",
    rangeKey: "sk",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "pk", type: "S" },
        { name: "sk", type: "S" },
        { name: "gsi1pk", type: "S" },
        { name: "gsi1sk", type: "S" },
        { name: "gsi2pk", type: "S" },
        { name: "gsi2sk", type: "S" },
        { name: "gsi3pk", type: "S" },
        { name: "gsi3sk", type: "S" },
    ],
    ttl: { attributeName: "expire_at", enabled: true },
    globalSecondaryIndexes: [
        {
            name: "GSI1",
            hashKey: "gsi1pk",
            rangeKey: "gsi1sk",
            projectionType: "ALL",
        },
        {
            name: "GSI2",
            hashKey: "gsi2pk",
            rangeKey: "gsi2sk",
            projectionType: "ALL",
        },
        {
            name: "GSI3",
            hashKey: "gsi3pk",
            rangeKey: "gsi3sk",
            projectionType: "ALL",
        },
    ],
}, { retainOnDelete: true });

// 3. InventoryTable — auto-discovery single-table design
const inventoryTable = new aws.dynamodb.Table("inventoryTable", {
    name: "nucleus-cloud-ops-inventory-table",
    hashKey: "pk",
    rangeKey: "sk",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "pk", type: "S" },
        { name: "sk", type: "S" },
        { name: "gsi1pk", type: "S" },
        { name: "gsi1sk", type: "S" },
        { name: "gsi2pk", type: "S" },
        { name: "gsi2sk", type: "S" },
        { name: "gsi3pk", type: "S" },
        { name: "gsi3sk", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
    globalSecondaryIndexes: [
        {
            name: "GSI1",
            hashKey: "gsi1pk",
            rangeKey: "gsi1sk",
            projectionType: "ALL",
        },
        {
            name: "GSI2",
            hashKey: "gsi2pk",
            rangeKey: "gsi2sk",
            projectionType: "ALL",
        },
        {
            name: "GSI3",
            hashKey: "gsi3pk",
            rangeKey: "gsi3sk",
            projectionType: "ALL",
        },
    ],
}, { retainOnDelete: true });

// 4. UsersTeamsTable — RBAC users and teams (uppercase PK/SK)
const usersTeamsTable = new aws.dynamodb.Table("usersTeamsTable", {
    name: "nucleus-cloud-ops-web-ui-users-teams",
    hashKey: "PK",
    rangeKey: "SK",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "PK", type: "S" },
        { name: "SK", type: "S" },
        { name: "EntityType", type: "S" },
    ],
    globalSecondaryIndexes: [
        {
            name: "EntityTypeIndex",
            hashKey: "EntityType",
            projectionType: "ALL",
        },
    ],
}, { retainOnDelete: true });

// 5. CheckpointTable — LangGraph checkpoint state
const checkpointTable = new aws.dynamodb.Table("checkpointTable", {
    name: "nucleus-cloud-ops-checkpoints-table",
    hashKey: "thread_id",
    rangeKey: "checkpoint_id",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "thread_id", type: "S" },
        { name: "checkpoint_id", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
}, { retainOnDelete: true });

// 6. WritesTable — LangGraph pending writes (v2 schema)
const writesTable = new aws.dynamodb.Table("writesTable", {
    name: "nucleus-cloud-ops-checkpoint-writes-v2-table",
    hashKey: "thread_id_checkpoint_id_checkpoint_ns",
    rangeKey: "task_id_idx",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "thread_id_checkpoint_id_checkpoint_ns", type: "S" },
        { name: "task_id_idx", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
}, { retainOnDelete: true });

// 7. ChatHistoryTable — DynamoDBChatMessageHistory per user/session
const chatHistoryTable = new aws.dynamodb.Table("chatHistoryTable", {
    name: "nucleus-cloud-ops-chat-history",
    hashKey: "userId",
    rangeKey: "sessionId",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "userId", type: "S" },
        { name: "sessionId", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
}, { retainOnDelete: true });

// 8. MemoryTable — DynamoDBStore long-term agent memory
const memoryTable = new aws.dynamodb.Table("memoryTable", {
    name: "nucleus-cloud-ops-memory",
    hashKey: "user_id",
    rangeKey: "namespace_key",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "user_id", type: "S" },
        { name: "namespace_key", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
}, { retainOnDelete: true });

// 9. AgentOpsTable — background agent execution runs + events (uppercase PK/SK)
const agentOpsTable = new aws.dynamodb.Table("agentOpsTable", {
    name: "nucleus-cloud-ops-agent-ops",
    hashKey: "PK",
    rangeKey: "SK",
    billingMode: "PAY_PER_REQUEST",
    attributes: [
        { name: "PK", type: "S" },
        { name: "SK", type: "S" },
        { name: "GSI1PK", type: "S" },
        { name: "GSI1SK", type: "S" },
    ],
    ttl: { attributeName: "ttl", enabled: true },
    globalSecondaryIndexes: [
        {
            name: "GSI1",
            hashKey: "GSI1PK",
            rangeKey: "GSI1SK",
            projectionType: "ALL",
        },
    ],
}, { retainOnDelete: true });

// ============================================================================
// S3 BUCKETS
// ============================================================================

// 1. CheckpointBucket — LangGraph checkpoint offloading (30-day expiry)
const checkpointBucket = new aws.s3.BucketV2("checkpoint-bucket", {
    bucket: pulumi.interpolate`${appName}-checkpoints-bucket-${accountId}-${region}`,
    forceDestroy: false,
}, { retainOnDelete: true });

new aws.s3.BucketLifecycleConfigurationV2("checkpoint-bucket-lifecycle", {
    bucket: checkpointBucket.id,
    rules: [{
        id: "expire-all-30d",
        status: "Enabled",
        filter: {},
        expiration: { days: 30 },
    }],
});

// 2. AgentTempBucket — temporary agent storage (1-day expiry)
const agentTempBucket = new aws.s3.BucketV2("agent-temp-bucket", {
    bucket: pulumi.interpolate`${appName}-agent-temp-${accountId}-${region}`,
    forceDestroy: false,
}, { retainOnDelete: true });

new aws.s3.BucketLifecycleConfigurationV2("agent-temp-bucket-lifecycle", {
    bucket: agentTempBucket.id,
    rules: [{
        id: "expire-all-1d",
        status: "Enabled",
        filter: {},
        expiration: { days: 1 },
    }],
});

// 3. KBStagingBucket — KB sync staging (1-day expiry)
const kbStagingBucket = new aws.s3.BucketV2("kb-staging-bucket", {
    bucket: pulumi.interpolate`${appName}-kb-staging-${accountId}-${region}`,
    forceDestroy: false,
}, { retainOnDelete: true });

new aws.s3.BucketLifecycleConfigurationV2("kb-staging-bucket-lifecycle", {
    bucket: kbStagingBucket.id,
    rules: [{
        id: "expire-all-1d",
        status: "Enabled",
        filter: {},
        expiration: { days: 1 },
    }],
});

// 4. InventoryBucket — auto-discovery raw data + exports
const inventoryBucket = new aws.s3.BucketV2("inventory-bucket", {
    bucket: pulumi.interpolate`${appName}-inventory-${accountId}-${region}`,
    forceDestroy: false,
}, { retainOnDelete: true });

new aws.s3.BucketLifecycleConfigurationV2("inventory-bucket-lifecycle", {
    bucket: inventoryBucket.id,
    rules: [
        {
            id: "raw-expire-365d",
            status: "Enabled",
            filter: { prefix: "raw/" },
            expiration: { days: 365 },
        },
        {
            id: "exports-expire-7d",
            status: "Enabled",
            filter: { prefix: "exports/" },
            expiration: { days: 7 },
        },
    ],
});

// ============================================================================
// SQS QUEUES
// ============================================================================

// VectorProcessing pair — buffers S3 normalized/ events before vector processing
const vectorProcessingDlq = new aws.sqs.Queue("vector-processing-dlq", {
    name: "nucleus-cloud-ops-vector-processing-dlq",
    messageRetentionSeconds: 1209600, // 14 days
});

const vectorProcessingQueue = new aws.sqs.Queue("vector-processing-queue", {
    name: "nucleus-cloud-ops-vector-processing-queue",
    visibilityTimeoutSeconds: 900, // >= Lambda timeout of 15 min
    receiveWaitTimeSeconds: 20,    // long polling
    redrivePolicy: vectorProcessingDlq.arn.apply(dlqArn => JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: 3,
    })),
});

// Allow inventory bucket to send messages to the vector processing queue
new aws.sqs.QueuePolicy("vector-processing-queue-policy", {
    queueUrl: vectorProcessingQueue.url,
    policy: pulumi.all([vectorProcessingQueue.arn, inventoryBucket.arn]).apply(
        ([queueArn, bucketArn]) => JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Principal: { Service: "s3.amazonaws.com" },
                Action: "sqs:SendMessage",
                Resource: queueArn,
                Condition: { ArnLike: { "aws:SourceArn": bucketArn } },
            }],
        })
    ),
});

// KBSync pair — buffers KB sync jobs
const kbSyncDlq = new aws.sqs.Queue("kb-sync-dlq", {
    name: "nucleus-cloud-ops-kb-sync-dlq",
    messageRetentionSeconds: 1209600, // 14 days
});

const kbSyncQueue = new aws.sqs.Queue("kb-sync-queue", {
    name: "nucleus-cloud-ops-kb-sync-queue",
    visibilityTimeoutSeconds: 900,
    receiveWaitTimeSeconds: 20,
    redrivePolicy: kbSyncDlq.arn.apply(dlqArn => JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: 3,
    })),
});

// ============================================================================
// CLOUDWATCH ALARMS
// ============================================================================

new aws.cloudwatch.MetricAlarm("vector-dlq-alarm", {
    name: "nucleus-cloud-ops-vector-dlq-depth",
    alarmDescription: "Vector processor DLQ has messages — check Lambda errors",
    namespace: "AWS/SQS",
    metricName: "ApproximateNumberOfMessagesVisible",
    dimensions: { QueueName: vectorProcessingDlq.name },
    statistic: "Sum",
    period: 300,
    evaluationPeriods: 1,
    threshold: 1,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    treatMissingData: "notBreaching",
});

// ============================================================================
// COGNITO AUTHENTICATION
// ============================================================================

// UserPool — self-signup enabled, email sign-in, case-insensitive
const userPool = new aws.cognito.UserPool("web-ui-user-pool", {
    name: "nucleus-cloud-ops-web-ui-user-pool",
    autoVerifiedAttributes: ["email"],
    usernameAttributes: ["email"],
    usernameConfiguration: { caseSensitive: false },
    passwordPolicy: {
        minimumLength: 8,
        requireNumbers: true,
        requireLowercase: true,
        requireSymbols: false,
        requireUppercase: false,
        temporaryPasswordValidityDays: 7,
    },
    accountRecoverySetting: {
        recoveryMechanisms: [{ name: "verified_email", priority: 1 }],
    },
    schemas: [
        { name: "email", attributeDataType: "String", required: true, mutable: true },
        { name: "name", attributeDataType: "String", required: false, mutable: true },
        { name: "given_name", attributeDataType: "String", required: false, mutable: true },
        { name: "family_name", attributeDataType: "String", required: false, mutable: true },
    ],
});

// UserPoolDomain — hosted UI domain prefix
const userPoolDomain = new aws.cognito.UserPoolDomain("web-ui-user-pool-domain", {
    userPoolId: userPool.id,
    domain: pulumi.interpolate`nucleus-cloud-ops-web-ui-auth-${accountId}`,
});

// UserPoolClient — OAuth code grant, secret required for NextAuth
const userPoolClient = new aws.cognito.UserPoolClient("web-ui-user-pool-client", {
    name: "nucleus-cloud-ops-web-ui-app-client",
    userPoolId: userPool.id,
    generateSecret: true,
    explicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_USER_SRP_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
    ],
    allowedOauthFlows: ["code"],
    allowedOauthFlowsUserPoolClient: true,
    allowedOauthScopes: ["openid", "email", "profile", "aws.cognito.signin.user.admin"],
    callbackUrls: [
        "http://localhost:3000/api/auth/callback/cognito",
        `${appUrl}/api/auth/callback/cognito`,
    ],
    logoutUrls: ["http://localhost:3000", appUrl],
    preventUserExistenceErrors: "ENABLED",
    enableTokenRevocation: true,
    accessTokenValidity: 1,
    idTokenValidity: 1,
    refreshTokenValidity: 30,
    tokenValidityUnits: {
        accessToken: "hours",
        idToken: "hours",
        refreshToken: "days",
    },
    supportedIdentityProviders: ["COGNITO"],
});

// IdentityPool — links UserPoolClient to federated identity
const identityPool = new aws.cognito.IdentityPool("web-ui-identity-pool", {
    identityPoolName: "nucleus-cloud-ops-web-ui-identity-pool",
    allowUnauthenticatedIdentities: false,
    cognitoIdentityProviders: [{
        clientId: userPoolClient.id,
        providerName: userPool.endpoint,
    }],
});

// AuthenticatedRole — Cognito federated principal
const authenticatedRole = new aws.iam.Role("web-ui-authenticated-role", {
    name: "nucleus-cloud-ops-web-ui-authenticated-role",
    assumeRolePolicy: identityPool.id.apply(poolId =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Principal: { Federated: "cognito-identity.amazonaws.com" },
                Action: "sts:AssumeRoleWithWebIdentity",
                Condition: {
                    StringEquals: { "cognito-identity.amazonaws.com:aud": poolId },
                    "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" },
                },
            }],
        })
    ),
});

// Inline policy 1 — cognito-sync + mobile analytics
new aws.iam.RolePolicy("web-ui-auth-cognito-sync-policy", {
    role: authenticatedRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: ["mobileanalytics:PutEvents", "cognito-sync:*", "cognito-identity:*"],
            Resource: ["*"],
        }],
    }),
});

// Inline policy 2 — DynamoDB on UsersTeamsTable
new aws.iam.RolePolicy("web-ui-auth-dynamodb-policy", {
    role: authenticatedRole.id,
    policy: pulumi.all([usersTeamsTable.arn]).apply(([tableArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
                    "dynamodb:Query", "dynamodb:Scan", "dynamodb:DeleteItem",
                ],
                Resource: [tableArn, `${tableArn}/index/*`],
            }],
        })
    ),
});

// Wire authenticated role to identity pool
new aws.cognito.IdentityPoolRoleAttachment("web-ui-identity-pool-role-attachment", {
    identityPoolId: identityPool.id,
    roles: { authenticated: authenticatedRole.arn },
});

// ============================================================================
// SNS TOPIC
// ============================================================================

const snsTopic = new aws.sns.Topic("scheduler-sns-topic", {
    name: "nucleus-cloud-ops-sns-topic",
});

// Email subscriptions from config (comma-separated, skip empty)
const emails = subscriptionEmails.split(",").map((e: string) => e.trim()).filter((e: string) => e.length > 0);
emails.forEach((email: string, i: number) => {
    new aws.sns.TopicSubscription(`sns-email-sub-${i}`, {
        topic: snsTopic.arn,
        protocol: "email",
        endpoint: email,
    });
});

// ============================================================================
// SCHEDULER LAMBDA
// ============================================================================

// IAM Role for Scheduler Lambda
const schedulerLambdaRole = new aws.iam.Role("scheduler-lambda-role", {
    name: "nucleus-cloud-ops-lambda-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
    managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    ],
});

// Inline policy — DynamoDB access on app + audit tables
new aws.iam.RolePolicy("scheduler-lambda-dynamodb-policy", {
    role: schedulerLambdaRole.id,
    policy: pulumi.all([appTable.arn, auditTable.arn]).apply(([appArn, auditArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:Query",
                    "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
                    "dynamodb:BatchWriteItem",
                ],
                Resource: [
                    appArn, `${appArn}/index/*`,
                    auditArn, `${auditArn}/index/*`,
                ],
            }],
        })
    ),
});

// Inline policy — cross-account STS AssumeRole
new aws.iam.RolePolicy("scheduler-lambda-sts-policy", {
    role: schedulerLambdaRole.id,
    policy: pulumi.output(crossAccountRoleName).apply(roleName =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["sts:AssumeRole"],
                Resource: [
                    `arn:aws:iam::*:role/${roleName}`,
                    "arn:aws:iam::*:role/NucleusAccess-*",
                ],
            }],
        })
    ),
});

// Inline policy — SNS Publish
new aws.iam.RolePolicy("scheduler-lambda-sns-policy", {
    role: schedulerLambdaRole.id,
    policy: snsTopic.arn.apply(topicArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["sns:Publish"],
                Resource: [topicArn],
            }],
        })
    ),
});

// Scheduler Lambda Function
const schedulerLambda = new aws.lambda.Function("scheduler-lambda", {
    name: "nucleus-cloud-ops-function",
    role: schedulerLambdaRole.arn,
    runtime: "nodejs20.x",
    architectures: ["arm64"],
    handler: "index.handler",
    code: new pulumi.asset.FileArchive("../../lambda/scheduler/lambda.zip"),
    timeout: 900,
    memorySize: 1024,
    environment: {
        variables: {
            APP_TABLE_NAME: appTable.name,
            AUDIT_TABLE_NAME: auditTable.name,
            CROSS_ACCOUNT_ROLE_ARN: schedulerLambdaRole.arn,
            SCHEDULER_TAG: "cost-optimization-scheduler",
            SNS_TOPIC_ARN: snsTopic.arn,
            HUB_ACCOUNT_ID: accountId,
            NEXT_PUBLIC_HUB_ACCOUNT_ID: accountId,
        },
    },
});

// ============================================================================
// EVENTBRIDGE RULE — Scheduler cron trigger
// ============================================================================

const schedulerRule = new aws.cloudwatch.EventRule("scheduler-trigger-rule", {
    name: "nucleus-cloud-ops-rule",
    scheduleExpression: "cron(0,30 * * * ? *)",
});

new aws.cloudwatch.EventTarget("scheduler-trigger-target", {
    rule: schedulerRule.name,
    arn: schedulerLambda.arn,
});

new aws.lambda.Permission("scheduler-eventbridge-permission", {
    action: "lambda:InvokeFunction",
    function: schedulerLambda.name,
    principal: "events.amazonaws.com",
    sourceArn: schedulerRule.arn,
});

// ============================================================================
// VECTOR PROCESSOR LAMBDA
// ============================================================================

// IAM Role for VectorProcessor Lambda
const vectorProcessorRole = new aws.iam.Role("vector-processor-role", {
    name: "nucleus-cloud-ops-vector-processor-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
    managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    ],
});

// Inline policy — S3 read on inventory bucket
new aws.iam.RolePolicy("vector-processor-s3-policy", {
    role: vectorProcessorRole.id,
    policy: pulumi.all([inventoryBucket.arn]).apply(([bucketArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:ListBucket"],
                Resource: [bucketArn, `${bucketArn}/*`],
            }],
        })
    ),
});

// Inline policy — DynamoDB read/write on appTable + auditTable
new aws.iam.RolePolicy("vector-processor-dynamodb-policy", {
    role: vectorProcessorRole.id,
    policy: pulumi.all([appTable.arn, auditTable.arn]).apply(([appArn, auditArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan",
                    "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
                    "dynamodb:BatchWriteItem",
                ],
                Resource: [
                    appArn, `${appArn}/index/*`,
                    auditArn, `${auditArn}/index/*`,
                ],
            }],
        })
    ),
});

// Inline policy — S3 Vectors permissions
new aws.iam.RolePolicy("vector-processor-s3vectors-policy", {
    role: vectorProcessorRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "s3vectors:PutVectors",
                "s3vectors:DeleteVectors",
                "s3vectors:QueryVectors",
                "s3vectors:CreateVectorIndex",
                "s3vectors:GetIndex",
            ],
            Resource: ["*"],
        }],
    }),
});

// Inline policy — Bedrock embedding
new aws.iam.RolePolicy("vector-processor-bedrock-policy", {
    role: vectorProcessorRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: ["bedrock:InvokeModel"],
            Resource: ["*"],
        }],
    }),
});

// Inline policy — SQS receive from vectorProcessingQueue
new aws.iam.RolePolicy("vector-processor-sqs-policy", {
    role: vectorProcessorRole.id,
    policy: vectorProcessingQueue.arn.apply(queueArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "sqs:ReceiveMessage",
                    "sqs:DeleteMessage",
                    "sqs:GetQueueAttributes",
                ],
                Resource: [queueArn],
            }],
        })
    ),
});

// VectorProcessor Lambda Function
const vectorProcessorLambda = new aws.lambda.Function("vector-processor-lambda", {
    name: "nucleus-cloud-ops-vector-processor",
    role: vectorProcessorRole.arn,
    runtime: "nodejs20.x",
    architectures: ["arm64"],
    handler: "index.handler",
    code: new pulumi.asset.FileArchive("../../lambda/vector_processor/lambda.zip"),
    timeout: 900,
    memorySize: 1024,
    reservedConcurrentExecutions: 10,
    environment: {
        variables: {
            INVENTORY_BUCKET_NAME: inventoryBucket.bucket,
            VECTOR_BUCKET_NAME: vectorBucketName,
            VECTOR_BUCKET_ARN: "",  // placeholder — Phase 11 wires real S3 Vectors
            VECTOR_INDEX_NAME: "text-embeddings",
            BEDROCK_MODEL_ID: "amazon.titan-embed-text-v2:0",
            APP_TABLE_NAME: appTable.name,
            AUDIT_TABLE_NAME: auditTable.name,
        },
    },
});

// SQS EventSourceMapping — VectorProcessor triggered by vectorProcessingQueue
new aws.lambda.EventSourceMapping("vector-processor-sqs-trigger", {
    eventSourceArn: vectorProcessingQueue.arn,
    functionName: vectorProcessorLambda.arn,
    batchSize: 1,
    scalingConfig: {
        maximumConcurrency: 5,
    },
});

// S3 BucketNotification — inventory bucket normalized/ prefix → vectorProcessingQueue
new aws.s3.BucketNotification("inventory-bucket-notification", {
    bucket: inventoryBucket.id,
    queues: [{
        queueArn: vectorProcessingQueue.arn,
        events: ["s3:ObjectCreated:*"],
        filterPrefix: "normalized/",
    }],
});

// ============================================================================
// KB SYNC PROCESSOR LAMBDA
// ============================================================================

// IAM Role for KBSyncProcessor Lambda
const kbSyncProcessorRole = new aws.iam.Role("kb-sync-processor-role", {
    name: "nucleus-cloud-ops-kb-sync-processor-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
    managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    ],
});

// Inline policy — S3 read/write on kbStagingBucket
new aws.iam.RolePolicy("kb-sync-processor-kb-staging-policy", {
    role: kbSyncProcessorRole.id,
    policy: pulumi.all([kbStagingBucket.arn]).apply(([bucketArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket",
                ],
                Resource: [bucketArn, `${bucketArn}/*`],
            }],
        })
    ),
});

// Inline policy — S3 read on arbitrary buckets (s3-sync data source type)
new aws.iam.RolePolicy("kb-sync-processor-s3-read-policy", {
    role: kbSyncProcessorRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:ListBucket"],
            Resource: ["*"],
        }],
    }),
});

// Inline policy — DynamoDB read/write on appTable
new aws.iam.RolePolicy("kb-sync-processor-dynamodb-policy", {
    role: kbSyncProcessorRole.id,
    policy: appTable.arn.apply(tableArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan",
                    "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
                    "dynamodb:BatchWriteItem",
                ],
                Resource: [tableArn, `${tableArn}/index/*`],
            }],
        })
    ),
});

// Inline policy — S3 Vectors permissions
new aws.iam.RolePolicy("kb-sync-processor-s3vectors-policy", {
    role: kbSyncProcessorRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "s3vectors:PutVectors",
                "s3vectors:DeleteVectors",
                "s3vectors:QueryVectors",
            ],
            Resource: ["*"],
        }],
    }),
});

// Inline policy — Bedrock embedding
new aws.iam.RolePolicy("kb-sync-processor-bedrock-policy", {
    role: kbSyncProcessorRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: ["bedrock:InvokeModel"],
            Resource: ["*"],
        }],
    }),
});

// Inline policy — SQS receive from kbSyncQueue
new aws.iam.RolePolicy("kb-sync-processor-sqs-policy", {
    role: kbSyncProcessorRole.id,
    policy: kbSyncQueue.arn.apply(queueArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "sqs:ReceiveMessage",
                    "sqs:DeleteMessage",
                    "sqs:GetQueueAttributes",
                ],
                Resource: [queueArn],
            }],
        })
    ),
});

// KBSyncProcessor Lambda Function
const kbSyncProcessorLambda = new aws.lambda.Function("kb-sync-processor-lambda", {
    name: "nucleus-cloud-ops-kb-sync-processor",
    role: kbSyncProcessorRole.arn,
    runtime: "nodejs20.x",
    architectures: ["arm64"],
    handler: "index.handler",
    code: new pulumi.asset.FileArchive("../../lambda/kb_sync_processor/lambda.zip"),
    timeout: 900,
    memorySize: 1024,
    environment: {
        variables: {
            APP_TABLE_NAME: appTable.name,
            KB_VECTOR_BUCKET_NAME: vectorBucketName,  // placeholder — Phase 11
            KB_VECTOR_INDEX_NAME: "knowledge-base-embeddings",
            KB_STAGING_BUCKET_NAME: kbStagingBucket.bucket,
            BEDROCK_MODEL_ID: "amazon.titan-embed-text-v2:0",
        },
    },
});

// SQS EventSourceMapping — KBSyncProcessor triggered by kbSyncQueue
new aws.lambda.EventSourceMapping("kb-sync-processor-sqs-trigger", {
    eventSourceArn: kbSyncQueue.arn,
    functionName: kbSyncProcessorLambda.arn,
    batchSize: 1,
});

// ============================================================================
// DISCOVERY ECS TASK DEFINITION + IAM + SECURITY GROUP + EVENTBRIDGE RULE
// ============================================================================

// CloudWatch Log Group for Discovery
const discoveryLogGroup = new aws.cloudwatch.LogGroup("discovery-log-group", {
    name: "/ecs/nucleus-cloud-ops-discovery",
    retentionInDays: 14,
});

// Discovery ECS Execution Role — ECR pull + CloudWatch logs
const discoveryExecutionRole = new aws.iam.Role("discovery-execution-role", {
    name: "nucleus-cloud-ops-discovery-execution-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
});

new aws.iam.RolePolicyAttachment("discovery-execution-role-policy", {
    role: discoveryExecutionRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

// Discovery Task Role — cross-account STS, DynamoDB, S3, S3Tables, CloudWatch Logs
const discoveryTaskRole = new aws.iam.Role("discovery-task-role", {
    name: "nucleus-cloud-ops-discovery-task-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
});

new aws.iam.RolePolicy("discovery-task-role-policy", {
    role: discoveryTaskRole.id,
    policy: pulumi.all([
        appTable.arn,
        inventoryTable.arn,
        auditTable.arn,
        inventoryBucket.arn,
        discoveryLogGroup.arn,
    ]).apply(([appArn, inventoryArn, auditArn, bucketArn, logGroupArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: ["sts:AssumeRole"],
                    Resource: [
                        `arn:aws:iam::*:role/${crossAccountRoleName}`,
                        "arn:aws:iam::*:role/NucleusAccess-*",
                    ],
                },
                {
                    Effect: "Allow",
                    Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem"],
                    Resource: [appArn, `${appArn}/index/*`],
                },
                {
                    Effect: "Allow",
                    Action: [
                        "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan",
                        "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:BatchWriteItem",
                        "dynamodb:DeleteItem",
                    ],
                    Resource: [inventoryArn, `${inventoryArn}/index/*`],
                },
                {
                    Effect: "Allow",
                    Action: ["dynamodb:PutItem"],
                    Resource: [auditArn],
                },
                {
                    Effect: "Allow",
                    Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
                    Resource: [bucketArn, `${bucketArn}/*`],
                },
                {
                    Effect: "Allow",
                    Action: ["s3tables:*"],
                    Resource: ["*"],
                },
                {
                    Effect: "Allow",
                    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                    Resource: [logGroupArn],
                },
            ],
        })
    ),
});

// Discovery Security Group — egress only (AWS API calls)
const discoverySecurityGroup = new aws.ec2.SecurityGroup("discovery-sg", {
    name: "nucleus-cloud-ops-discovery-sg",
    description: "Security Group for AWS Auto-Discovery ECS Task",
    vpcId: vpcId,
    egress: [{
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
        description: "Allow all outbound for AWS API calls",
    }],
});

// Discovery ECS Task Definition — ARM64, FARGATE, 1024 CPU / 2048 MiB (matches CDK)
const discoveryTaskDef = new aws.ecs.TaskDefinition("discovery-task-def", {
    family: "nucleus-cloud-ops-discovery",
    cpu: "1024",
    memory: "2048",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: discoveryExecutionRole.arn,
    taskRoleArn: discoveryTaskRole.arn,
    runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
    },
    containerDefinitions: pulumi.all([
        appTable.name,
        auditTable.name,
        inventoryBucket.bucket,
        discoveryLogGroup.name,
    ]).apply(([appTableN, auditTableN, inventoryBucketN, logGroupN]) =>
        JSON.stringify([{
            name: "DiscoveryContainer",
            image: discoveryImageUri || "public.ecr.aws/docker/library/python:3.12-slim",
            essential: true,
            environment: [
                { name: "APP_TABLE_NAME", value: appTableN },
                { name: "AUDIT_TABLE_NAME", value: auditTableN },
                { name: "INVENTORY_BUCKET_NAME", value: inventoryBucketN },
                { name: "AWS_REGION", value: region },
                { name: "CROSS_ACCOUNT_ROLE_NAME", value: crossAccountRoleName },
            ],
            logConfiguration: {
                logDriver: "awslogs",
                options: {
                    "awslogs-group": logGroupN,
                    "awslogs-region": region,
                    "awslogs-stream-prefix": "discovery",
                },
            },
        }])
    ),
});

// EventBridge Rule — on-demand StartDiscovery trigger (Phase 10 adds ECS target)
const discoveryTriggerRule = new aws.cloudwatch.EventRule("discovery-trigger-rule", {
    name: "nucleus-cloud-ops-discovery-trigger-rule",
    eventPattern: JSON.stringify({
        source: ["nucleus.app"],
        "detail-type": ["StartDiscovery"],
    }),
});

// ============================================================================
// ECS + ALB + CLOUDFRONT
// ============================================================================

// ECR Repository — WebUI container images
const ecrRepository = new aws.ecr.Repository("web-ui-ecr-repo", {
    name: "nucleus-cloud-ops-web-ui",
    imageTagMutability: "MUTABLE",
    forceDelete: false,
});

// ECS Cluster
const ecsCluster = new aws.ecs.Cluster("web-ui-ecs-cluster", {
    name: "nucleus-cloud-ops-ecs-cluster",
    settings: [{ name: "containerInsights", value: "enabled" }],
});

// WebUI CloudWatch Log Group
const webUiLogGroup = new aws.cloudwatch.LogGroup("web-ui-log-group", {
    name: "/ecs/nucleus-cloud-ops-web-ui-service",
    retentionInDays: 7,
});

// ECS Task Execution Role — ECR pull + CloudWatch logs
const ecsTaskExecutionRole = new aws.iam.Role("ecs-task-execution-role", {
    name: "nucleus-cloud-ops-ecs-execution-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
});

new aws.iam.RolePolicyAttachment("ecs-task-execution-role-policy", {
    role: ecsTaskExecutionRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

// ECS Task Role — application permissions
const ecsTaskRole = new aws.iam.Role("ecs-task-role", {
    name: "nucleus-cloud-ops-ecs-task-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
});

// 5a. DynamoDB — read/write on all 9 tables + GSI indexes
new aws.iam.RolePolicy("ecs-task-dynamodb-policy", {
    role: ecsTaskRole.id,
    policy: pulumi.all([
        appTable.arn, auditTable.arn, inventoryTable.arn,
        usersTeamsTable.arn, checkpointTable.arn, writesTable.arn,
        chatHistoryTable.arn, memoryTable.arn, agentOpsTable.arn,
    ]).apply(([appArn, auditArn, inventoryArn, usersTeamsArn, checkpointArn, writesArn, chatHistoryArn, memoryArn, agentOpsArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
                    "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
                    "dynamodb:BatchWriteItem", "dynamodb:BatchGetItem",
                ],
                Resource: [
                    appArn, `${appArn}/index/*`,
                    auditArn, `${auditArn}/index/*`,
                    inventoryArn, `${inventoryArn}/index/*`,
                    usersTeamsArn, `${usersTeamsArn}/index/*`,
                    checkpointArn, `${checkpointArn}/index/*`,
                    writesArn, `${writesArn}/index/*`,
                    chatHistoryArn, `${chatHistoryArn}/index/*`,
                    memoryArn, `${memoryArn}/index/*`,
                    agentOpsArn, `${agentOpsArn}/index/*`,
                ],
            }],
        })
    ),
});

// 5b. S3 — read/write on 4 buckets
new aws.iam.RolePolicy("ecs-task-s3-policy", {
    role: ecsTaskRole.id,
    policy: pulumi.all([
        checkpointBucket.arn, agentTempBucket.arn,
        inventoryBucket.arn, kbStagingBucket.arn,
    ]).apply(([cpArn, atArn, invArn, kbArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
                    "s3:ListBucket", "s3:GetBucketLocation",
                ],
                Resource: [
                    cpArn, `${cpArn}/*`,
                    atArn, `${atArn}/*`,
                    invArn, `${invArn}/*`,
                    kbArn, `${kbArn}/*`,
                ],
            }],
        })
    ),
});

// 5c. SQS — SendMessage on kbSyncQueue
new aws.iam.RolePolicy("ecs-task-sqs-policy", {
    role: ecsTaskRole.id,
    policy: kbSyncQueue.arn.apply(queueArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["sqs:SendMessage"],
                Resource: [queueArn],
            }],
        })
    ),
});

// 5d. Bedrock — InvokeModel
new aws.iam.RolePolicy("ecs-task-bedrock-policy", {
    role: ecsTaskRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
            Resource: ["*"],
        }],
    }),
});

// 5e. STS — cross-account AssumeRole
new aws.iam.RolePolicy("ecs-task-sts-policy", {
    role: ecsTaskRole.id,
    policy: pulumi.output(crossAccountRoleName).apply(roleName =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["sts:AssumeRole"],
                Resource: [
                    "arn:aws:iam::*:role/NucleusAccess-*",
                    `arn:aws:iam::*:role/${roleName}`,
                ],
            }],
        })
    ),
});

// 5f. S3Vectors — placeholder ARNs (Phase 11 scopes to real bucket)
new aws.iam.RolePolicy("ecs-task-s3vectors-policy", {
    role: ecsTaskRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "s3vectors:QueryVectors", "s3vectors:PutVectors",
                "s3vectors:DeleteVectors", "s3vectors:GetVectors",
                "s3vectors:ListVectorIndices",
            ],
            Resource: ["*"],
        }],
    }),
});

// 5g. CloudWatch Logs
new aws.iam.RolePolicy("ecs-task-logs-policy", {
    role: ecsTaskRole.id,
    policy: webUiLogGroup.arn.apply(logArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: [logArn, `${logArn}:*`],
            }],
        })
    ),
});

// WebUI Task Definition — ARM64, FARGATE, 512 CPU / 1024 MiB
const webUiTaskDef = new aws.ecs.TaskDefinition("web-ui-task-def", {
    family: "nucleus-cloud-ops-web-ui-task",
    cpu: "512",
    memory: "1024",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: ecsTaskExecutionRole.arn,
    taskRoleArn: ecsTaskRole.arn,
    runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
    },
    containerDefinitions: pulumi.all([
        appTable.name,
        auditTable.name,
        checkpointTable.name,
        writesTable.name,
        checkpointBucket.bucket,
        chatHistoryTable.name,
        memoryTable.name,
        usersTeamsTable.name,
        userPool.id,
        userPoolClient.id,
        userPoolClient.clientSecret,
        identityPool.id,
        inventoryBucket.bucket,
        inventoryTable.name,
        kbSyncQueue.url,
        kbStagingBucket.bucket,
        agentTempBucket.bucket,
        agentOpsTable.name,
        schedulerLambda.arn,
        ecsTaskRole.arn,
        webUiLogGroup.name,
        accountId,
        nextauthSecret,
    ]).apply(([
        appTableN, auditTableN, checkpointTableN, writesTableN,
        checkpointBucketN, chatHistoryTableN, memoryTableN, usersTeamsTableN,
        cognitoPoolId, cognitoClientId, cognitoClientSecret, identityPoolId,
        inventoryBucketN, inventoryTableN, kbSyncQueueUrl, kbStagingBucketN,
        agentTempBucketN, agentOpsTableN, schedulerLambdaArnVal, ecsTaskRoleArnVal,
        webUiLogGroupN, acctId, nextauthSecretVal,
    ]) => JSON.stringify([{
        name: "WebUIContainer",
        image: webUiImageUri,
        essential: true,
        portMappings: [{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }],
        logConfiguration: {
            logDriver: "awslogs",
            options: {
                "awslogs-group": webUiLogGroupN,
                "awslogs-region": region,
                "awslogs-stream-prefix": "web-ui",
            },
        },
        environment: [
            { name: "NODE_ENV", value: "production" },
            { name: "PORT", value: "3000" },
            { name: "AWS_REGION", value: region },
            { name: "NEXT_PUBLIC_AWS_REGION", value: region },
            { name: "NEXT_PUBLIC_HUB_ACCOUNT_ID", value: acctId },
            { name: "HUB_ACCOUNT_ID", value: acctId },
            { name: "APP_TABLE_NAME", value: appTableN },
            { name: "NEXT_PUBLIC_APP_TABLE_NAME", value: appTableN },
            { name: "AUDIT_TABLE_NAME", value: auditTableN },
            { name: "NEXT_PUBLIC_AUDIT_TABLE_NAME", value: auditTableN },
            { name: "DYNAMODB_CHECKPOINT_TABLE", value: checkpointTableN },
            { name: "DYNAMODB_WRITES_TABLE", value: writesTableN },
            { name: "CHECKPOINT_S3_BUCKET", value: checkpointBucketN },
            { name: "DYNAMODB_CHAT_HISTORY_TABLE", value: chatHistoryTableN },
            { name: "DYNAMODB_MEMORY_TABLE", value: memoryTableN },
            { name: "DYNAMODB_USERS_TEAMS_TABLE", value: usersTeamsTableN },
            { name: "COGNITO_USER_POOL_ID", value: cognitoPoolId },
            { name: "NEXT_PUBLIC_COGNITO_USER_POOL_ID", value: cognitoPoolId },
            { name: "COGNITO_USER_POOL_CLIENT_ID", value: cognitoClientId },
            { name: "NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID", value: cognitoClientId },
            { name: "COGNITO_CLIENT_SECRET", value: cognitoClientSecret },
            { name: "COGNITO_DOMAIN", value: `nucleus-cloud-ops-web-ui-auth-${acctId}.auth.${region}.amazoncognito.com` },
            { name: "NEXT_PUBLIC_COGNITO_DOMAIN", value: `nucleus-cloud-ops-web-ui-auth-${acctId}.auth.${region}.amazoncognito.com` },
            { name: "COGNITO_REGION", value: region },
            { name: "NEXT_PUBLIC_COGNITO_REGION", value: region },
            { name: "COGNITO_IDENTITY_POOL_ID", value: identityPoolId },
            { name: "NEXT_PUBLIC_COGNITO_IDENTITY_POOL_ID", value: identityPoolId },
            { name: "NEXTAUTH_URL", value: appUrl },
            { name: "NEXT_PUBLIC_NEXTAUTH_URL", value: appUrl },
            { name: "NEXTAUTH_SECRET", value: nextauthSecretVal },
            { name: "COGNITO_ISSUER", value: `https://cognito-idp.${region}.amazonaws.com/${cognitoPoolId}` },
            { name: "NEXT_PUBLIC_COGNITO_ISSUER", value: `https://cognito-idp.${region}.amazonaws.com/${cognitoPoolId}` },
            { name: "AWS_LAMBDA_EXECUTION_ROLE_ARN", value: ecsTaskRoleArnVal },
            { name: "NEXT_PUBLIC_AWS_LAMBDA_EXECUTION_ROLE_ARN", value: ecsTaskRoleArnVal },
            { name: "AWS_USE_STS", value: "true" },
            { name: "NEXT_PUBLIC_AWS_USE_STS", value: "true" },
            { name: "COGNITO_APP_CLIENT_ID", value: cognitoClientId },
            { name: "COGNITO_APP_CLIENT_SECRET", value: cognitoClientSecret },
            { name: "DATA_DIR", value: "/tmp" },
            { name: "SCHEDULER_LAMBDA_ARN", value: schedulerLambdaArnVal },
            { name: "EVENTBRIDGE_RULE_NAME", value: "nucleus-cloud-ops-rule" },
            { name: "AGENT_TEMP_BUCKET", value: agentTempBucketN },
            { name: "AGENT_OPS_TABLE_NAME", value: agentOpsTableN },
            { name: "INVENTORY_BUCKET_NAME", value: inventoryBucketN },
            { name: "INVENTORY_TABLE_NAME", value: inventoryTableN },
            { name: "VECTOR_BUCKET_NAME", value: vectorBucketName || "" },
            { name: "VECTOR_INDEX_NAME", value: "text-embeddings" },
            { name: "BEDROCK_MODEL_ID", value: "amazon.titan-embed-text-v2:0" },
            { name: "KB_VECTOR_BUCKET_NAME", value: vectorBucketName || "" },
            { name: "KB_VECTOR_INDEX_NAME", value: "knowledge-base-embeddings" },
            { name: "KB_SYNC_QUEUE_URL", value: kbSyncQueueUrl },
            { name: "KB_STAGING_BUCKET_NAME", value: kbStagingBucketN },
            { name: "ASK_AI_GENERATION_MODEL", value: "global.anthropic.claude-sonnet-4-6" },
            { name: "LANGFUSE_ENABLED", value: "false" },
            { name: "LANGFUSE_PUBLIC_KEY", value: "" },
            { name: "LANGFUSE_SECRET_KEY", value: "" },
            { name: "LANGFUSE_HOST", value: "https://cloud.langfuse.com" },
        ],
    }])),
});

// ============================================================================
// ALB + SECURITY GROUPS + TARGET GROUP + LISTENER
// ============================================================================

// Look up CloudFront managed prefix list (restricts ALB inbound to CloudFront only)
const cloudFrontPrefixList = aws.ec2.getManagedPrefixListOutput({
    name: "com.amazonaws.global.cloudfront.origin-facing",
});

// ALB Security Group — inbound port 80 from CloudFront managed prefix list only
const albSecurityGroup = new aws.ec2.SecurityGroup("alb-sg", {
    name: "nucleus-cloud-ops-alb-sg",
    description: "Security group for WebUI ALB - CloudFront origin only",
    vpcId: vpcId,
    ingress: [{
        fromPort: 80,
        toPort: 80,
        protocol: "tcp",
        prefixListIds: [cloudFrontPrefixList.id],
        description: "HTTP from CloudFront managed prefix list",
    }],
    egress: [{
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
        description: "Allow all outbound",
    }],
});

// ECS Service Security Group — inbound port 3000 from ALB security group only
const ecsServiceSecurityGroup = new aws.ec2.SecurityGroup("ecs-service-sg", {
    name: "nucleus-cloud-ops-ecs-service-sg",
    description: "Security group for WebUI ECS tasks - ALB traffic only",
    vpcId: vpcId,
    ingress: [{
        fromPort: 3000,
        toPort: 3000,
        protocol: "tcp",
        securityGroups: [albSecurityGroup.id],
        description: "Container port from ALB",
    }],
    egress: [{
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
        description: "Allow all outbound",
    }],
});

// Application Load Balancer — internet-facing, idleTimeout 1200s for long streaming requests
const alb = new aws.lb.LoadBalancer("web-ui-alb", {
    name: "nucleus-cloud-ops-alb",
    internal: false,
    loadBalancerType: "application",
    securityGroups: [albSecurityGroup.id],
    subnets: publicSubnetIds,
    idleTimeout: 1200,
});

// Target Group — IP target type, port 3000, /api/health health check
const webUiTargetGroup = new aws.lb.TargetGroup("web-ui-tg", {
    name: "nucleus-cloud-ops-web-ui-tg",
    port: 3000,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: vpcId,
    deregistrationDelay: 30,
    healthCheck: {
        path: "/api/health",
        interval: 60,
        timeout: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 3,
        matcher: "200",
    },
});

// HTTP Listener — port 80, forward to target group
const httpListener = new aws.lb.Listener("http-listener", {
    loadBalancerArn: alb.arn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{
        type: "forward",
        targetGroupArn: webUiTargetGroup.arn,
    }],
});

// ============================================================================
// ECS FARGATE SERVICE + AUTO SCALING
// ============================================================================

// ECS Fargate Service — forceNewDeployment, circuit breaker with rollback, desiredCount 0
const webUiService = new aws.ecs.Service("web-ui-service", {
    name: "nucleus-cloud-ops-web-ui-service",
    cluster: ecsCluster.arn,
    taskDefinition: webUiTaskDef.arn,
    desiredCount: 0,  // safe start — scale up after smoke testing
    launchType: "FARGATE",
    forceNewDeployment: true,
    deploymentCircuitBreaker: {
        enable: true,
        rollback: true,
    },
    deploymentMinimumHealthyPercent: 100,
    deploymentMaximumPercent: 200,
    networkConfiguration: {
        subnets: privateSubnetIds,
        securityGroups: [ecsServiceSecurityGroup.id],
        assignPublicIp: false,
    },
    loadBalancers: [{
        targetGroupArn: webUiTargetGroup.arn,
        containerName: "WebUIContainer",
        containerPort: 3000,
    }],
}, { dependsOn: [httpListener] });

// Auto Scaling Target — min 2, max 10
const scalingTarget = new aws.appautoscaling.Target("web-ui-scaling-target", {
    maxCapacity: 10,
    minCapacity: 2,
    resourceId: pulumi.interpolate`service/${ecsCluster.name}/${webUiService.name}`,
    scalableDimension: "ecs:service:DesiredCount",
    serviceNamespace: "ecs",
});

// CPU Scaling Policy — target 70%
new aws.appautoscaling.Policy("web-ui-cpu-scaling", {
    name: "nucleus-cloud-ops-web-ui-cpu-scaling",
    policyType: "TargetTrackingScaling",
    resourceId: scalingTarget.resourceId,
    scalableDimension: scalingTarget.scalableDimension,
    serviceNamespace: scalingTarget.serviceNamespace,
    targetTrackingScalingPolicyConfiguration: {
        predefinedMetricSpecification: {
            predefinedMetricType: "ECSServiceAverageCPUUtilization",
        },
        targetValue: 70,
    },
});

// Memory Scaling Policy — target 75%
new aws.appautoscaling.Policy("web-ui-memory-scaling", {
    name: "nucleus-cloud-ops-web-ui-memory-scaling",
    policyType: "TargetTrackingScaling",
    resourceId: scalingTarget.resourceId,
    scalableDimension: scalingTarget.scalableDimension,
    serviceNamespace: scalingTarget.serviceNamespace,
    targetTrackingScalingPolicyConfiguration: {
        predefinedMetricSpecification: {
            predefinedMetricType: "ECSServiceAverageMemoryUtilization",
        },
        targetValue: 75,
    },
});

// ============================================================================
// STACK OUTPUTS
// ============================================================================

// ECS + ECR exports (Phase 10)
export const ecsClusterArn = ecsCluster.arn;
export const ecsClusterName = ecsCluster.name;
export const ecrRepositoryUri = ecrRepository.repositoryUrl;
export const webUiTaskDefinitionArn = webUiTaskDef.arn;

export const networkingVpcId = vpcId;
export const networkingVpcCidr = vpcCidr;

// DynamoDB table name exports (for Phase 9/10 consumption via requireOutput)
export const appTableName = appTable.name;
export const auditTableName = auditTable.name;
export const inventoryTableName = inventoryTable.name;
export const usersTeamsTableName = usersTeamsTable.name;
export const checkpointTableName = checkpointTable.name;
export const writesTableName = writesTable.name;
export const chatHistoryTableName = chatHistoryTable.name;
export const memoryTableName = memoryTable.name;
export const agentOpsTableName = agentOpsTable.name;

// S3 bucket exports
export const checkpointBucketName = checkpointBucket.bucket;
export const checkpointBucketArn = checkpointBucket.arn;
export const agentTempBucketName = agentTempBucket.bucket;
export const agentTempBucketArn = agentTempBucket.arn;
export const kbStagingBucketName = kbStagingBucket.bucket;
export const kbStagingBucketArn = kbStagingBucket.arn;
export const inventoryBucketName = inventoryBucket.bucket;
export const inventoryBucketArn = inventoryBucket.arn;

// SQS exports
export const vectorProcessingQueueUrl = vectorProcessingQueue.url;
export const vectorProcessingQueueArn = vectorProcessingQueue.arn;
export const vectorProcessingDlqArn = vectorProcessingDlq.arn;
export const kbSyncQueueUrl = kbSyncQueue.url;
export const kbSyncQueueArn = kbSyncQueue.arn;
export const kbSyncDlqArn = kbSyncDlq.arn;
// Cognito exports
export const cognitoUserPoolId = userPool.id;
export const cognitoUserPoolArn = userPool.arn;
export const cognitoUserPoolClientId = userPoolClient.id;
export const cognitoUserPoolClientSecret = pulumi.secret(userPoolClient.clientSecret);
export const cognitoIdentityPoolId = identityPool.id;
export const cognitoDomainPrefix = pulumi.interpolate`nucleus-cloud-ops-web-ui-auth-${accountId}`;

// Scheduler Lambda + SNS exports
export const schedulerLambdaArn = schedulerLambda.arn;
export const snsTopicArn = snsTopic.arn;

// VectorProcessor + KBSyncProcessor exports
export const vectorProcessorArn = vectorProcessorLambda.arn;
export const kbSyncProcessorArn = kbSyncProcessorLambda.arn;

// Discovery ECS task exports
export const discoveryTaskDefinitionArn = discoveryTaskDef.arn;
export const discoveryTaskRoleArn = discoveryTaskRole.arn;
export const discoveryExecutionRoleArn = discoveryExecutionRole.arn;
export const discoverySecurityGroupId = discoverySecurityGroup.id;

// ============================================================================
// CLOUDFRONT DISTRIBUTION
// ============================================================================

// Stable origin verify secret — random.RandomString does NOT change on every preview
// (unlike crypto.randomBytes which would force CloudFront update on every deploy)
const originVerifySecret = new random.RandomString("origin-verify-secret", {
    length: 32,
    special: false,
});

const cloudFrontDistribution = new aws.cloudfront.Distribution("web-ui-cloudfront", {
    enabled: true,
    comment: "Nucleus Cloud Ops WebUI",
    defaultRootObject: "",
    httpVersion: "http2",
    isIpv6Enabled: true,
    priceClass: "PriceClass_All",

    origins: [{
        domainName: alb.dnsName,
        originId: "alb-origin",
        customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: "http-only",
            originSslProtocols: ["TLSv1.2"],
            originReadTimeout: 60,
            originKeepaliveTimeout: 60,
        },
        customHeaders: [{
            name: "X-Origin-Verify",
            value: originVerifySecret.result,
        }],
    }],

    defaultCacheBehavior: {
        targetOriginId: "alb-origin",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
        cachedMethods: ["GET", "HEAD"],
        compress: true,
        // Caching disabled — forward all requests to ALB
        forwardedValues: {
            queryString: true,
            headers: ["*"],
            cookies: { forward: "all" },
        },
        minTtl: 0,
        defaultTtl: 0,
        maxTtl: 0,
    },

    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },

    viewerCertificate: {
        cloudfrontDefaultCertificate: true,
    },
});

// ============================================================================
// DISCOVERY EVENTBRIDGE SCHEDULER (deferred from Phase 9 — needs cluster ARN)
// ============================================================================

// Scheduler IAM Role — allows EventBridge Scheduler to run ECS tasks
const discoverySchedulerRole = new aws.iam.Role("discovery-scheduler-role", {
    name: "nucleus-cloud-ops-discovery-scheduler-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "scheduler.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
});

new aws.iam.RolePolicy("discovery-scheduler-ecs-policy", {
    role: discoverySchedulerRole.id,
    policy: pulumi.all([
        discoveryTaskDef.arn,
        discoveryExecutionRole.arn,
        discoveryTaskRole.arn,
    ]).apply(([taskDefArn, execRoleArn, taskRoleArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: ["ecs:RunTask"],
                    Resource: [taskDefArn],
                },
                {
                    Effect: "Allow",
                    Action: ["iam:PassRole"],
                    Resource: [execRoleArn, taskRoleArn],
                },
            ],
        })
    ),
});

// Daily Discovery Schedule — 2AM UTC
const dailyDiscoverySchedule = new aws.scheduler.Schedule("daily-discovery-schedule", {
    name: "nucleus-cloud-ops-daily-discovery",
    description: "Runs AWS resource discovery daily at 2:00 AM UTC",
    scheduleExpression: "cron(0 2 * * ? *)",
    flexibleTimeWindow: { mode: "OFF" },
    state: "ENABLED",
    target: {
        arn: ecsCluster.arn,
        roleArn: discoverySchedulerRole.arn,
        ecsParameters: {
            taskDefinitionArn: discoveryTaskDef.arn,
            launchType: "FARGATE",
            taskCount: 1,
            networkConfiguration: {
                subnets: privateSubnetIds,
                securityGroups: [discoverySecurityGroup.id],
                assignPublicIp: false,
            },
        },
    },
});

// Wire on-demand StartDiscovery rule to ECS cluster (deferred from Phase 9)
new aws.cloudwatch.EventTarget("discovery-trigger-target", {
    rule: discoveryTriggerRule.name,
    arn: ecsCluster.arn,
    roleArn: discoverySchedulerRole.arn,  // reuse same role — has ecs:RunTask + iam:PassRole
    ecsTarget: {
        taskDefinitionArn: discoveryTaskDef.arn,
        launchType: "FARGATE",
        taskCount: 1,
        networkConfiguration: {
            subnets: privateSubnetIds,
            securityGroups: [discoverySecurityGroup.id],
            assignPublicIp: false,
        },
    },
});

// ============================================================================
// PHASE 10 STACK OUTPUTS — ECS + ALB + CloudFront
// ============================================================================

export const webUiServiceName = webUiService.name;
export const albDnsName = alb.dnsName;
export const albArn = alb.arn;
export const cloudFrontUrl = pulumi.interpolate`https://${cloudFrontDistribution.domainName}`;
export const cloudFrontDistributionId = cloudFrontDistribution.id;
export const originVerifySecretValue = pulumi.secret(originVerifySecret.result);

// ============================================================================
// PHASE 11: S3 VECTORS + S3 TABLES — CloudFormation Stack Wrappers
// ============================================================================
// These resources use alpha CDK constructs with no native Pulumi equivalent.
// CFN templates extracted from `cdk synth` output and wrapped in Pulumi.

const s3VectorsTemplate = fs.readFileSync(
    path.join(__dirname, "s3-vectors-template.json"),
    "utf-8"
);

const s3VectorsCfnStack = new aws.cloudformation.Stack("s3-vectors-stack", {
    name: "nucleus-cloud-ops-s3-vectors-stack",
    templateBody: s3VectorsTemplate,
    capabilities: ["CAPABILITY_IAM"],
});

const s3TablesTemplate = fs.readFileSync(
    path.join(__dirname, "s3-tables-template.json"),
    "utf-8"
);

const s3TablesCfnStack = new aws.cloudformation.Stack("s3-tables-stack", {
    name: "nucleus-cloud-ops-s3-tables-stack",
    templateBody: s3TablesTemplate,
    capabilities: ["CAPABILITY_IAM"],
});

export const s3VectorsCfnStackId = s3VectorsCfnStack.id;
export const s3TablesCfnStackId = s3TablesCfnStack.id;

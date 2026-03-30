import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// Account ID + region for resource name suffixes (no top-level await needed)
const callerIdentity = aws.getCallerIdentityOutput({});
const accountId = callerIdentity.accountId;
const region = aws.config.region ?? "us-east-1";

// Pulumi config
const config = new pulumi.Config();
const appUrl = config.get("appUrl") ?? "https://placeholder.cloudfront.net";

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
// STACK OUTPUTS
// ============================================================================

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

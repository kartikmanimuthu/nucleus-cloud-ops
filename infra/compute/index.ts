import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as command from "@pulumi/command";
import * as random from "@pulumi/random";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// Hash a source directory recursively — used as a trigger so build commands
// only re-run when source files actually change.
function hashDirectory(dir: string): string {
    const hash = crypto.createHash("sha256");
    function walk(d: string) {
        if (!fs.existsSync(d)) return;
        const entries = fs.readdirSync(d, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                if (["node_modules", "dist", ".next"].includes(entry.name)) continue;
                walk(full);
            } else {
                hash.update(entry.name);
                hash.update(fs.readFileSync(full));
            }
        }
    }
    walk(dir);
    return hash.digest("hex");
}

const repoRoot = path.resolve(__dirname, "../..");

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
const nextauthSecret = config.requireSecret("nextauthSecret");
const dbPassword = config.requireSecret("dbPassword");

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
// RDS POSTGRESQL
// ============================================================================

// RDS Security Group — allow port 5432 from within VPC (ECS tasks + Lambdas)
const rdsSecurityGroup = new aws.ec2.SecurityGroup("rds-sg", {
    name: "nucleus-cloud-ops-rds-sg",
    description: "Security group for RDS PostgreSQL - VPC internal access",
    vpcId: vpcId,
    ingress: [{
        fromPort: 5432,
        toPort: 5432,
        protocol: "tcp",
        cidrBlocks: [vpcCidr],
        description: "PostgreSQL from VPC (ECS tasks and Lambda functions)",
    }],
    egress: [{
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
        description: "Allow all outbound",
    }],
});

// RDS PostgreSQL instance — postgres 16, db.t4g.micro, 20 GB gp3
const postgresInstance = new aws.rds.Instance("postgres", {
    identifier: "nucleus-cloud-ops-postgres",
    engine: "postgres",
    engineVersion: "16.6",
    instanceClass: "db.t4g.micro",
    dbName: "nucleus",
    username: "nucleus_admin",
    password: dbPassword,
    dbSubnetGroupName: dbSubnetGroupName,
    vpcSecurityGroupIds: [rdsSecurityGroup.id],
    multiAz: false,
    allocatedStorage: 20,
    storageType: "gp3",
    skipFinalSnapshot: true,
    deletionProtection: false,
    tags: { Name: "nucleus-cloud-ops-postgres" },
}, { retainOnDelete: false });

// DATABASE_URL — secret-wrapped connection string
const databaseUrl = pulumi.secret(
    pulumi.interpolate`postgresql://nucleus_admin:${dbPassword}@${postgresInstance.address}:5432/nucleus`
);


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

// Auto-build VectorProcessor Lambda — reruns when source changes
const vectorSrcHash = hashDirectory(path.join(repoRoot, "lambda/vector_processor/src"));
const buildVectorProcessor = new command.local.Command("build-vector-processor", {
    create: `bash ${repoRoot}/infra/build-lambdas.sh --lambda=vector_processor`,
    update: `bash ${repoRoot}/infra/build-lambdas.sh --lambda=vector_processor`,
    triggers: [vectorSrcHash],
    dir: repoRoot,
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
            DATABASE_URL: databaseUrl,
        },
    },
}, { dependsOn: [buildVectorProcessor] });
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
// ECS + ALB + CLOUDFRONT
// ============================================================================

// ECR Repository — WebUI container images
const ecrRepository = new aws.ecr.Repository("web-ui-ecr-repo", {
    name: "nucleus-cloud-ops-web-ui",
    imageTagMutability: "MUTABLE",
    forceDelete: false,
});

// Explicit source hash — combines web-ui/ + prisma/ so any change to either
// produces a new imageTag, forcing a Docker rebuild + new ECS task definition revision.
const webUiSrcHash = crypto.createHash("sha256")
    .update(hashDirectory(path.join(repoRoot, "web-ui")))
    .update(hashDirectory(path.join(repoRoot, "prisma")))
    .digest("hex")
    .substring(0, 12);

const webUiImage = new awsx.ecr.Image("web-ui-image", {
    repositoryUrl: ecrRepository.repositoryUrl,
    context: repoRoot,
    dockerfile: path.join(repoRoot, "web-ui/Dockerfile.ecs"),
    platform: "linux/arm64",
    imageTag: webUiSrcHash,
    args: {
        BUILDX_NO_DEFAULT_ATTESTATIONS: "1",
    },
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
        kbStagingBucket.bucket,
        agentTempBucket.bucket,
        agentOpsTable.name,
        ecsTaskRole.arn,
        webUiLogGroup.name,
        accountId,
        nextauthSecret,
        databaseUrl,
        webUiImage.imageUri,
    ]).apply(([
        appTableN, auditTableN, checkpointTableN, writesTableN,
        checkpointBucketN, chatHistoryTableN, memoryTableN, usersTeamsTableN,
        cognitoPoolId, cognitoClientId, cognitoClientSecret, identityPoolId,
        inventoryBucketN, inventoryTableN, kbStagingBucketN,
        agentTempBucketN, agentOpsTableN, ecsTaskRoleArnVal,
        webUiLogGroupN, acctId, nextauthSecretVal, databaseUrlVal, imageUri,
    ]) => JSON.stringify([{
        name: "WebUIContainer",
        image: imageUri,
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
            { name: "KB_STAGING_BUCKET_NAME", value: kbStagingBucketN },
            { name: "ASK_AI_GENERATION_MODEL", value: "global.anthropic.claude-sonnet-4-6" },
            { name: "LANGFUSE_ENABLED", value: "false" },
            { name: "LANGFUSE_PUBLIC_KEY", value: "" },
            { name: "LANGFUSE_SECRET_KEY", value: "" },
            { name: "LANGFUSE_HOST", value: "https://cloud.langfuse.com" },
            { name: "DATABASE_URL", value: databaseUrlVal },
            // PostgreSQL feature flags — disable DynamoDB, route all entities to PostgreSQL
            { name: "USE_PG_ACCOUNTS", value: "true" },
            { name: "USE_PG_SCHEDULES", value: "true" },
            { name: "USE_PG_AUDIT", value: "true" },
            { name: "USE_PG_AUDIT_LOGS", value: "true" },
            { name: "USE_PG_INVENTORY", value: "true" },
            { name: "USE_PG_AGENT_OPS", value: "true" },
            { name: "USE_PG_LANGGRAPH", value: "true" },
            { name: "USE_PG_RBAC", value: "true" },
            { name: "USE_PG_TENANT_CONFIG", value: "true" },
            { name: "USE_PG_KB", value: "true" },
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

// ECS Fargate Service — forceNewDeployment, circuit breaker with rollback
const webUiService = new aws.ecs.Service("web-ui-service", {
    name: "nucleus-cloud-ops-web-ui-service",
    cluster: ecsCluster.arn,
    taskDefinition: webUiTaskDef.arn,
    desiredCount: 1,
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
// Cognito exports
export const cognitoUserPoolId = userPool.id;
export const cognitoUserPoolArn = userPool.arn;
export const cognitoUserPoolClientId = userPoolClient.id;
export const cognitoUserPoolClientSecret = pulumi.secret(userPoolClient.clientSecret);
export const cognitoIdentityPoolId = identityPool.id;
export const cognitoDomainPrefix = pulumi.interpolate`nucleus-cloud-ops-web-ui-auth-${accountId}`;

// SNS exports
export const snsTopicArn = snsTopic.arn;

// VectorProcessor exports
export const vectorProcessorArn = vectorProcessorLambda.arn;

// ============================================================================
// RDS POSTGRESQL — IAM rds-db:connect policies
// ============================================================================

new aws.iam.RolePolicy("ecs-task-rds-connect-policy", {
    role: ecsTaskRole.id,
    policy: postgresInstance.arn.apply(rdsArn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["rds-db:connect"], Resource: [rdsArn] }],
    })),
});

new aws.iam.RolePolicy("vector-processor-rds-connect-policy", {
    role: vectorProcessorRole.id,
    policy: postgresInstance.arn.apply(rdsArn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["rds-db:connect"], Resource: [rdsArn] }],
    })),
});

// RDS PostgreSQL exports
export const postgresEndpoint = postgresInstance.address;
export { databaseUrl };

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
// PG-BOSS WORKERS ECS SERVICE
// ============================================================================

// ECR Repository — Workers container images
const workersEcrRepo = new aws.ecr.Repository("workers-ecr-repo", {
    name: "nucleus-cloud-ops-workers",
    imageTagMutability: "MUTABLE",
    forceDelete: false,
});

// Explicit source hash — combines workers/ + prisma/ so any change forces a rebuild.
const workersSrcHash = crypto.createHash("sha256")
    .update(hashDirectory(path.join(repoRoot, "workers")))
    .update(hashDirectory(path.join(repoRoot, "prisma")))
    .digest("hex")
    .substring(0, 12);

// Workers Docker image — auto-built and pushed to ECR on source change
const workersImage = new awsx.ecr.Image("workers-image", {
    repositoryUrl: workersEcrRepo.repositoryUrl,
    context: repoRoot,
    dockerfile: path.join(repoRoot, "workers/Dockerfile"),
    platform: "linux/arm64",
    imageTag: workersSrcHash,
    args: {
        BUILDX_NO_DEFAULT_ATTESTATIONS: "1",
    },
});

const workersLogGroup = new aws.cloudwatch.LogGroup("workers-log-group", {
    name: "/ecs/nucleus-cloud-ops-workers",
    retentionInDays: 7,
});

const workersTaskRole = new aws.iam.Role("workers-task-role", {
    name: "nucleus-cloud-ops-workers-task-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
});

new aws.iam.RolePolicy("workers-dynamodb-policy", {
    role: workersTaskRole.id,
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

new aws.iam.RolePolicy("workers-sts-policy", {
    role: workersTaskRole.id,
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

new aws.iam.RolePolicy("workers-sns-policy", {
    role: workersTaskRole.id,
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

new aws.iam.RolePolicy("workers-bedrock-policy", {
    role: workersTaskRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: ["bedrock:InvokeModel"],
            Resource: ["*"],
        }],
    }),
});

new aws.iam.RolePolicy("workers-s3vectors-policy", {
    role: workersTaskRole.id,
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

new aws.iam.RolePolicy("workers-s3-policy", {
    role: workersTaskRole.id,
    policy: pulumi.all([kbStagingBucket.arn]).apply(([bucketArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
                    Resource: [bucketArn, `${bucketArn}/*`],
                },
                {
                    Effect: "Allow",
                    Action: ["s3:GetObject", "s3:ListBucket"],
                    Resource: ["*"],
                },
            ],
        })
    ),
});

// Ephemeral workers CloudWatch log group — short-lived job tasks
const ephemeralWorkersLogGroup = new aws.cloudwatch.LogGroup("ephemeral-workers-log-group", {
    name: "/ecs/nucleus-cloud-ops-ephemeral-workers",
    retentionInDays: 7,
});

new aws.iam.RolePolicy("workers-logs-policy", {
    role: workersTaskRole.id,
    policy: pulumi.all([workersLogGroup.arn, ephemeralWorkersLogGroup.arn]).apply(([logArn, ephLogArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: [logArn, `${logArn}:*`, ephLogArn, `${ephLogArn}:*`],
            }],
        })
    ),
});

new aws.iam.RolePolicy("workers-rds-connect-policy", {
    role: workersTaskRole.id,
    policy: postgresInstance.arn.apply(dbArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["rds-db:connect"],
                Resource: [`${dbArn.replace(':rds:', ':rds-db:').replace(':db:', ':dbuser:')}/nucleus_admin`],
            }],
        })
    ),
});

// Ephemeral worker task definition — lightweight tasks for horizontal dispatch
const ephemeralWorkerTaskDef = new aws.ecs.TaskDefinition("ephemeral-worker-task-def", {
    family: "nucleus-cloud-ops-ephemeral-worker-task",
    cpu: "256",
    memory: "512",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: ecsTaskExecutionRole.arn,
    taskRoleArn: workersTaskRole.arn,
    runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
    },
    containerDefinitions: pulumi.all([
        appTable.name,
        auditTable.name,
        kbStagingBucket.bucket,
        ephemeralWorkersLogGroup.name,
        databaseUrl,
        snsTopic.arn,
        workersImage.imageUri,
    ]).apply(([
        appTableN, auditTableN, kbStagingBucketN,
        ephLogGroupN, databaseUrlVal, snsTopicArn, imageUri,
    ]) => JSON.stringify([{
        name: "WorkersContainer",
        image: imageUri,
        essential: true,
        logConfiguration: {
            logDriver: "awslogs",
            options: {
                "awslogs-group": ephLogGroupN,
                "awslogs-region": region,
                "awslogs-stream-prefix": "ephemeral",
            },
        },
        environment: [
            { name: "NODE_ENV", value: "production" },
            { name: "AWS_REGION", value: region },
            { name: "DATABASE_URL", value: databaseUrlVal.includes("?") ? `${databaseUrlVal}&sslmode=no-verify` : `${databaseUrlVal}?sslmode=no-verify` },
            { name: "APP_TABLE_NAME", value: appTableN },
            { name: "AUDIT_TABLE_NAME", value: auditTableN },
            { name: "SNS_TOPIC_ARN", value: snsTopicArn },
            { name: "CROSS_ACCOUNT_ROLE_NAME", value: crossAccountRoleName },
            { name: "KB_VECTOR_BUCKET_NAME", value: vectorBucketName || "" },
            { name: "KB_VECTOR_INDEX_NAME", value: "knowledge-base-embeddings" },
            { name: "KB_STAGING_BUCKET_NAME", value: kbStagingBucketN },
            { name: "BEDROCK_MODEL_ID", value: "amazon.titan-embed-text-v2:0" },
            { name: "USE_PG_SCHEDULES", value: "true" },
            { name: "USE_PG_KB", value: "true" },
            { name: "LOG_LEVEL", value: "info" },
        ],
    }])),
});

// IAM policy for workers to dispatch ECS tasks (horizontal executor)
new aws.iam.RolePolicy("workers-ecs-dispatch-policy", {
    role: workersTaskRole.id,
    policy: pulumi.all([ephemeralWorkerTaskDef.arn, ecsCluster.arn, workersTaskRole.arn, ecsTaskExecutionRole.arn]).apply(
        ([taskDefArn, clusterArn, taskRoleArn, execRoleArn]) =>
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
                        Action: ["ecs:DescribeTasks"],
                        Resource: ["*"],
                        Condition: {
                            ArnEquals: {
                                "ecs:cluster": clusterArn,
                            },
                        },
                    },
                    {
                        Effect: "Allow",
                        Action: ["iam:PassRole"],
                        Resource: [taskRoleArn, execRoleArn],
                    },
                ],
            })
    ),
});

const workersSecurityGroup = new aws.ec2.SecurityGroup("workers-sg", {
    name: "nucleus-cloud-ops-workers-sg",
    description: "Security group for pg-boss workers - egress only",
    vpcId: vpcId,
    egress: [{
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
        description: "Allow all outbound for AWS API calls + PostgreSQL",
    }],
});

const workersTaskDef = new aws.ecs.TaskDefinition("workers-task-def", {
    family: "nucleus-cloud-ops-workers-task",
    cpu: "512",
    memory: "1024",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: ecsTaskExecutionRole.arn,
    taskRoleArn: workersTaskRole.arn,
    runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
    },
    containerDefinitions: pulumi.all([
        appTable.name,
        auditTable.name,
        kbStagingBucket.bucket,
        workersLogGroup.name,
        databaseUrl,
        snsTopic.arn,
        workersImage.imageUri,
        ecsCluster.arn,
        ephemeralWorkerTaskDef.arn,
        workersSecurityGroup.id,
        privateSubnetIds.apply(ids => ids.join(",")),
    ]).apply(([
        appTableN, auditTableN, kbStagingBucketN,
        workersLogGroupN, databaseUrlVal, snsTopicArn, imageUri,
        clusterArn, ephTaskDefArn, workersSgId, subnetsJoined,
    ]) => JSON.stringify([{
        name: "WorkersContainer",
        image: imageUri,
        essential: true,
        logConfiguration: {
            logDriver: "awslogs",
            options: {
                "awslogs-group": workersLogGroupN,
                "awslogs-region": region,
                "awslogs-stream-prefix": "workers",
            },
        },
        environment: [
            { name: "NODE_ENV", value: "production" },
            { name: "AWS_REGION", value: region },
            { name: "DATABASE_URL", value: databaseUrlVal.includes("?") ? `${databaseUrlVal}&sslmode=no-verify` : `${databaseUrlVal}?sslmode=no-verify` },
            { name: "APP_TABLE_NAME", value: appTableN },
            { name: "AUDIT_TABLE_NAME", value: auditTableN },
            { name: "SNS_TOPIC_ARN", value: snsTopicArn },
            { name: "CROSS_ACCOUNT_ROLE_NAME", value: crossAccountRoleName },
            { name: "KB_VECTOR_BUCKET_NAME", value: vectorBucketName || "" },
            { name: "KB_VECTOR_INDEX_NAME", value: "knowledge-base-embeddings" },
            { name: "KB_STAGING_BUCKET_NAME", value: kbStagingBucketN },
            { name: "BEDROCK_MODEL_ID", value: "amazon.titan-embed-text-v2:0" },
            { name: "USE_PG_SCHEDULES", value: "true" },
            { name: "USE_PG_KB", value: "true" },
            { name: "LOG_LEVEL", value: "info" },
            { name: "HORIZONTAL_CLUSTER_ARN", value: clusterArn },
            { name: "HORIZONTAL_TASK_DEF_ARN", value: ephTaskDefArn },
            { name: "HORIZONTAL_SUBNETS", value: subnetsJoined },
            { name: "HORIZONTAL_SECURITY_GROUP", value: workersSgId },
        ],
    }])),
});

const workersService = new aws.ecs.Service("workers-service", {
    name: "nucleus-cloud-ops-workers-service",
    cluster: ecsCluster.arn,
    taskDefinition: workersTaskDef.arn,
    desiredCount: 1,
    launchType: "FARGATE",
    forceNewDeployment: true,
    networkConfiguration: {
        subnets: privateSubnetIds,
        securityGroups: [workersSecurityGroup.id],
        assignPublicIp: false,
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

// Workers ECS exports
export const workersServiceName = workersService.name;
export const workersEcrRepoUrl = workersEcrRepo.repositoryUrl;
export const ephemeralWorkerTaskDefArn = ephemeralWorkerTaskDef.arn;

// ============================================================================
// PHASE 11: S3 VECTORS + S3 TABLES — CloudFormation Stack Wrappers
// ============================================================================
// These resources use alpha CDK constructs with no native Pulumi equivalent.
// CFN templates extracted from `cdk synth` output and wrapped in Pulumi.

// s3-vectors-stack disabled — will be removed in future milestone
// const s3VectorsTemplate = fs.readFileSync(path.join(__dirname, "s3-vectors-template.json"), "utf-8");
// const s3VectorsCfnStack = new aws.cloudformation.Stack("s3-vectors-stack", { ... });

const s3TablesTemplate = fs.readFileSync(
    path.join(__dirname, "s3-tables-template.json"),
    "utf-8"
);

const s3TablesCfnStack = new aws.cloudformation.Stack("s3-tables-stack", {
    name: "nucleus-cloud-ops-s3-tables-stack",
    templateBody: s3TablesTemplate,
    capabilities: ["CAPABILITY_IAM"],
});

// export const s3VectorsCfnStackId = s3VectorsCfnStack.id; // disabled
export const s3TablesCfnStackId = s3TablesCfnStack.id;

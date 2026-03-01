import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sns_subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as path from "path";
import * as crypto from "crypto";
import * as s3_notifications from "aws-cdk-lib/aws-s3-notifications";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as docdb from "aws-cdk-lib/aws-docdb";
import { Construct } from "constructs";
import { TableBucket, Namespace, Table, OpenTableFormat } from '@aws-cdk/aws-s3tables-alpha';
import { RemovalPolicy } from "aws-cdk-lib";
import { Bucket as VectorBucket, Index } from 'cdk-s3-vectors';
import { getConfig } from './config';

export interface ComputeStackProps extends cdk.StackProps {
    vpc: ec2.Vpc;
}

export class ComputeStack extends cdk.Stack {
    // Public outputs
    public readonly schedulerLambdaFunctionArn: string;
    public readonly ecsClusterName: string;
    public readonly webUiServiceName: string;
    public readonly webUiLoadBalancerUrl: string;
    public readonly userPool: cognito.UserPool;
    public readonly userPoolClient: cognito.UserPoolClient;
    public readonly identityPool: cognito.CfnIdentityPool;
    public readonly cloudFrontDistributionId: string;
    public readonly cloudFrontDomainName: string;
    public readonly webUiUrl: string;

    constructor(scope: Construct, id: string, props: ComputeStackProps) {
        super(scope, id, props);

        // ============================================================================
        // CONFIGURATION FROM CONFIG.TS (ENV VARS)
        // ============================================================================

        const config = getConfig();
        const appName = config.appName;
        const SCHEDULE_INTERVAL = 30; // Defaulting to 30 as context is being removed
        const CROSS_ACCOUNT_ROLE_NAME = 'CrossAccountRoleForCostOptimizationScheduler';
        const SCHEDULER_TAG = 'cost-optimization-scheduler';
        const subscriptionEmails = config.subscriptionEmails;
        const customDomainConfig = config.customDomain;
        const ecsConfig = config.ecs;

        const stackName = `${appName}`;
        const webUiStackName = `${appName}-web-ui`;

        // ============================================================================
        // DOCUMENTDB CLUSTER (MongoDB-compatible)
        // ============================================================================

        // Security group for DocumentDB — only allow inbound from within the VPC
        const docDbSg = new ec2.SecurityGroup(this, `${appName}-DocDbSg`, {
            vpc: props.vpc,
            description: 'DocumentDB security group',
            allowAllOutbound: false,
        });
        docDbSg.addIngressRule(
            ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
            ec2.Port.tcp(27017),
            'Allow DocumentDB from within VPC'
        );

        // Credentials stored in Secrets Manager
        const docDbSecret = new secretsmanager.Secret(this, `${appName}-DocDbSecret`, {
            secretName: `/${appName}/docdb/credentials`,
            generateSecretString: {
                secretStringTemplate: JSON.stringify({ username: 'nucleusadmin' }),
                generateStringKey: 'password',
                excludePunctuation: true,
                passwordLength: 32,
            },
        });

        // DocumentDB Cluster
        const docDbCluster = new docdb.DatabaseCluster(this, `${appName}-DocDbCluster`, {
            masterUser: {
                username: 'nucleusadmin',
                password: docDbSecret.secretValueFromJson('password'),
            },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            instances: 1,
            vpc: props.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroup: docDbSg,
            storageEncrypted: true,
            deletionProtection: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            dbClusterName: `${appName}-docdb`,
            engineVersion: '5.0.0',
        });

        const docDbEndpoint = docDbCluster.clusterEndpoint.hostname;
        const docDbPort = docDbCluster.clusterEndpoint.port;

        // Build the MongoDB-compatible connection string and store it as a separate secret
        const connectionStringSecret = new secretsmanager.Secret(this, `${appName}-DocDbConnectionString`, {
            secretName: `/${appName}/docdb/connection-string`,
            secretStringValue: cdk.SecretValue.unsafePlainText(
                `mongodb://nucleusadmin:PLACEHOLDER@${docDbEndpoint}:${docDbPort}/?tls=true&tlsCAFile=/etc/ssl/certs/rds-combined-ca-bundle.pem&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false`
            ),
        });

        // Table names
        const appTableName = `${stackName}-app-table`;
        const auditTableName = `${stackName}-audit-table`;
        const checkpointTableName = `${appName}-checkpoints-table`;
        const writesTableName = `${appName}-checkpoint-writes-v2-table`;
        const agentConversationsTableName = `${appName}-agent-conversations`;
        const chatHistoryTableName = `${appName}-chat-history`;
        const memoryTableName = `${appName}-memory`;
        const agentOpsTableName = `${appName}-agent-ops`;

        // ============================================================================
        // DYNAMODB TABLES (from cdkStack.ts)
        // ============================================================================

        // 1. Nucleus App Table (Single Table Design)
        const appTable = new dynamodb.Table(this, `${appName}-AppTable`, {
            partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            tableName: appTableName,
            removalPolicy: RemovalPolicy.DESTROY,
            timeToLiveAttribute: 'ttl',
        });

        // Add GSIs for App Table
        appTable.addGlobalSecondaryIndex({
            indexName: 'GSI1',
            partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
        });
        appTable.addGlobalSecondaryIndex({
            indexName: 'GSI2',
            partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
        });
        appTable.addGlobalSecondaryIndex({
            indexName: 'GSI3',
            partitionKey: { name: 'gsi3pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'gsi3sk', type: dynamodb.AttributeType.STRING },
        });

        // 2. Nucleus Audit Table
        const auditTable = new dynamodb.Table(this, `${appName}-AuditTable`, {
            partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            tableName: auditTableName,
            timeToLiveAttribute: 'expire_at',
            removalPolicy: RemovalPolicy.DESTROY,
        });

        // Add GSIs for Audit Table
        auditTable.addGlobalSecondaryIndex({
            indexName: 'GSI1',
            partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
        });
        auditTable.addGlobalSecondaryIndex({
            indexName: 'GSI2',
            partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
        });
        auditTable.addGlobalSecondaryIndex({
            indexName: 'GSI3',
            partitionKey: { name: 'gsi3pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'gsi3sk', type: dynamodb.AttributeType.STRING },
        });

        // 3. Nucleus Inventory Table (Auto-Discovery - Single Table Design)
        const inventoryTableName = `${appName}-inventory-table`;
        const inventoryTable = new dynamodb.Table(this, `${appName}-InventoryTable`, {
            partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            tableName: inventoryTableName,
            timeToLiveAttribute: 'ttl',
            removalPolicy: RemovalPolicy.DESTROY,
        });

        // GSIs for Inventory Table
        // GSI1: Query by resource type (TYPE#RESOURCE -> {resourceType}#{timestamp})
        inventoryTable.addGlobalSecondaryIndex({
            indexName: 'GSI1',
            partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
        });
        // GSI2: Query by region (REGION#{region} -> {resourceType}#{timestamp})
        inventoryTable.addGlobalSecondaryIndex({
            indexName: 'GSI2',
            partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
        });
        // GSI3: Query by resource type across all accounts (RESOURCE_TYPE#{type} -> {accountId}#{resourceId})
        inventoryTable.addGlobalSecondaryIndex({
            indexName: 'GSI3',
            partitionKey: { name: 'gsi3pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'gsi3sk', type: dynamodb.AttributeType.STRING },
        });

        // ============================================================================
        // DYNAMODB TABLES (from webUIStack.ts)
        // ============================================================================


        // Users Teams Table
        const usersTeamsTable = new dynamodb.Table(this, `${appName}-UsersTeamsTable`, {
            tableName: `${webUiStackName}-users-teams`,
            partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        usersTeamsTable.addGlobalSecondaryIndex({
            indexName: 'EntityTypeIndex',
            partitionKey: { name: 'EntityType', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // LangGraph Checkpoint Table
        const checkpointTable = new dynamodb.Table(this, `${appName}-CheckpointTable`, {
            tableName: checkpointTableName,
            partitionKey: { name: 'thread_id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'checkpoint_id', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // LangGraph Writes Table
        const writesTable = new dynamodb.Table(this, `${appName}-WritesTable`, {
            tableName: writesTableName,
            partitionKey: { name: 'thread_id_checkpoint_id_checkpoint_ns', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'task_id_idx', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Agent Conversations Table (for chat/thread persistence with tenant/user scoping)
        const agentConversationsTable = new dynamodb.Table(this, `${appName}-AgentConversationsTable`, {
            tableName: agentConversationsTableName,
            partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Chat History Table (@farukada/aws-langgraph-dynamodb-ts DynamoDBChatMessageHistory)
        const chatHistoryTable = new dynamodb.Table(this, `${appName}-ChatHistoryTable`, {
            tableName: chatHistoryTableName,
            partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Long-Term Memory Table (@farukada/aws-langgraph-dynamodb-ts DynamoDBStore)
        const memoryTable = new dynamodb.Table(this, `${appName}-MemoryTable`, {
            tableName: memoryTableName,
            partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'namespace_key', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Agent Ops Table (for background agent execution runs + events)
        const agentOpsTable = new dynamodb.Table(this, `${appName}-AgentOpsTable`, {
            tableName: agentOpsTableName,
            partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            timeToLiveAttribute: 'ttl',
        });
        agentOpsTable.addGlobalSecondaryIndex({
            indexName: 'GSI1',
            partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // GSI for direct thread access by ID
        agentConversationsTable.addGlobalSecondaryIndex({
            indexName: 'ThreadIdIndex',
            partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // ============================================================================
        // S3 BUCKET FOR LANGGRAPH CHECKPOINT OFFLOADING
        // ============================================================================

        const checkpointBucket = new s3.Bucket(this, `${appName}-CheckpointBucket`, {
            bucketName: `${appName}-checkpoints-bucket-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(30), // Auto-expire old checkpoints
                }
            ]
        });

        // ============================================================================
        // S3 BUCKET FOR AGENT TEMPORARY STORAGE
        // ============================================================================

        const agentTempBucket = new s3.Bucket(this, `${appName}-AgentTempBucket`, {
            bucketName: `${appName}-agent-temp-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(1), // Auto-expire temp files after due to temporary nature of storage
                }
            ]
        });

        // ============================================================================
        // S3 VECTOR BUCKET (cdk-s3-vectors)
        // ============================================================================

        const vectorBucket = new VectorBucket(this, `${appName}-VectorBucket`, {
            vectorBucketName: `${appName}-vectors-${this.account}-${this.region}`,
        });

        const vectorIndex = new Index(this, `${appName}-VectorIndex`, {
            vectorBucketName: vectorBucket.vectorBucketName, // Using Name as per PoC; construct handles mapping
            indexName: 'text-embeddings',
            dataType: 'float32',
            dimension: 1024,
            distanceMetric: 'cosine',
        });

        // ============================================================================
        // AUTO-DISCOVERY INFRASTRUCTURE
        // ============================================================================

        // S3 Bucket for inventory raw data and exports
        const inventoryBucket = new s3.Bucket(this, `${appName}-InventoryBucket`, {
            bucketName: `${appName}-inventory-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(365), // Keep raw inventory data for 1 year
                    prefix: 'raw/',
                },
                {
                    expiration: cdk.Duration.days(7), // Exports expire after 1 week
                    prefix: 'exports/',
                }
            ]
        });

        // Discovery Task Log Group
        const discoveryLogGroup = new logs.LogGroup(this, `${appName}-DiscoveryLogGroup`, {
            logGroupName: `/ecs/${appName}-discovery`,
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Discovery Task Role (for running the discovery container)
        const discoveryTaskRole = new iam.Role(this, `${appName}-DiscoveryTaskRole`, {
            roleName: `${appName}-discovery-task-role`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        // Cross-account assume role permissions for discovery
        discoveryTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['sts:AssumeRole'],
            resources: [
                `arn:aws:iam::*:role/${CROSS_ACCOUNT_ROLE_NAME}`,
                'arn:aws:iam::*:role/NucleusAccess-*'
            ],
        }));

        // DynamoDB permissions for discovery
        // App table: read accounts to scan and update sync status
        discoveryTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
            resources: [appTable.tableArn, `${appTable.tableArn}/index/*`],
        }));
        // Inventory table: write discovered resources
        discoveryTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan',
                'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem', 'dynamodb:DeleteItem',
            ],
            resources: [inventoryTable.tableArn, `${inventoryTable.tableArn}/index/*`],
        }));


        // S3 permissions for discovery
        inventoryBucket.grantReadWrite(discoveryTaskRole);

        // Vector Processor Lambda
        // Vector Processor Lambda (TypeScript)
        const vectorProcessor = new lambda_nodejs.NodejsFunction(
            this,
            `${appName}-VectorProcessor`,
            {
                functionName: `${stackName}-vector-processor`,
                runtime: lambda.Runtime.NODEJS_20_X,
                architecture: lambda.Architecture.ARM_64,
                entry: path.join(__dirname, "../lambda/vector_processor/src/index.ts"),
                handler: "handler",
                bundling: {
                    minify: true,
                    externalModules: [
                        '@aws-sdk/client-s3',
                        '@aws-sdk/client-bedrock-runtime'
                    ], // Bundle client-s3vectors and cheerio
                },
                timeout: cdk.Duration.minutes(15),
                memorySize: 1024,
                environment: {
                    INVENTORY_BUCKET_NAME: inventoryBucket.bucketName,
                    VECTOR_BUCKET_NAME: vectorBucket.vectorBucketName, // Use Name as we have Index now? Or ARN?
                    // In index.ts, we use PutVectorsCommand. 
                    // s3vectors (preview) usually takes Name + IndexName.
                    // The Fix in Python used ARN. 
                    // Let's pass ARN to be safe, as it's the unique identifier.
                    // But wait, the Index construct takes Name. 
                    // Let's pass BOTH and let the Lambda decide or use ARN.
                    // Actually, the previous fix confirmed ARN was needed for the *Bucket* resource to be found.
                    // But PutVectors might expect the Name if the client handles resolution.
                    // I will pass ARN as VECTOR_BUCKET_NAME to be consistent with the fix.
                    VECTOR_BUCKET_ARN: vectorBucket.vectorBucketArn,
                    // Also pass Name just in case
                    VECTOR_BUCKET_NAME_SIMPLE: vectorBucket.vectorBucketName,
                    VECTOR_INDEX_NAME: vectorIndex.indexName,
                    BEDROCK_MODEL_ID: "amazon.titan-embed-text-v2:0",
                },
            },
        );

        // Grant S3 permissions
        inventoryBucket.grantReadWrite(vectorProcessor);
        // vectorBucket is a custom resource, so we might need to manually grant if the L2 construct doesn't expose standard grant methods
        // The cdk-s3-vectors construct does not appear to expose a standard IBucket interface directly for the vector bucket
        // It exposes vectorBucketArn. Let's use addToRolePolicy for safety.
        vectorProcessor.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                "s3:PutObject", "s3:GetObject", "s3:ListBucket",
                "s3vectors:PutVectors", "s3vectors:CreateVectorIndex" // Ensure permission
            ],
            resources: [
                vectorBucket.vectorBucketArn,
                `${vectorBucket.vectorBucketArn}/*`,
                vectorIndex.indexArn // Grant permission on the index
            ]
        }));

        // Grant Bedrock permissions
        vectorProcessor.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ["bedrock:InvokeModel"],
                resources: ["*"],
            }),
        );

        // Add S3 Event Notification
        inventoryBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3_notifications.LambdaDestination(vectorProcessor),
            { prefix: "merged/" },
        );

        // S3 Tables permissions (for managed Iceberg tables)
        discoveryTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['s3tables:*'],
            resources: ['*'], // Allow all s3tables actions for now as ARN construction is tricky with new service
        }));

        // ============================================================================
        // S3 TABLES INFRASTRUCTURE (Iceberg)
        // ============================================================================

        // 1. Table Bucket
        const tableBucket = new TableBucket(this, `${appName}-TableBucket`, {
            tableBucketName: `${appName}-inventory-bucket`,
        });

        // 2. Namespace
        const namespace = new Namespace(this, `${appName}-Namespace`, {
            namespaceName: 'nucleus',
            tableBucket: tableBucket,
        });

        // 3. Resource Inventory Table
        const inventoryIcebergTable = new Table(this, `${appName}-InventoryIcebergTable`, {
            tableName: 'resources',
            namespace: namespace,
            openTableFormat: OpenTableFormat.ICEBERG,
            icebergMetadata: {
                icebergSchema: {
                    schemaFieldList: [
                        { name: 'resourceId', type: 'string', required: true },
                        { name: 'resourceType', type: 'string', required: true },
                        { name: 'name', type: 'string', required: false },
                        { name: 'arn', type: 'string', required: true },
                        { name: 'region', type: 'string', required: true },
                        { name: 'accountId', type: 'string', required: true },
                        { name: 'state', type: 'string', required: false },
                        { name: 'tags', type: 'string', required: false }, // serialized JSON
                        { name: 'lastSeenAt', type: 'timestamp', required: true },
                        { name: 'discoveryStatus', type: 'string', required: false }
                    ]
                }
            }
        });


        // ============================================================================
        // SNS TOPIC (from cdkStack.ts)
        // ============================================================================

        const snsTopic = new sns.Topic(this, `${appName}-SchedulerSNSTopic`, {
            topicName: `${stackName}-sns-topic`,
        });

        subscriptionEmails.forEach((email: string) => {
            snsTopic.addSubscription(new sns_subscriptions.EmailSubscription(email));
        });

        // ============================================================================
        // SCHEDULER LAMBDA (from cdkStack.ts)
        // ============================================================================

        const timestamp = new Date().getTime();
        const randomSuffix = crypto.randomBytes(4).toString('hex');
        const lambdaRoleName = `${stackName}-lambda-role-${timestamp}-${randomSuffix}`;

        const lambdaRole = new iam.Role(this, `${appName}-SchedulerLambdaRole`, {
            roleName: lambdaRoleName,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        // DynamoDB permissions
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:Query",
                "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
                "dynamodb:BatchWriteItem"
            ],
            resources: [
                appTable.tableArn, `${appTable.tableArn}/index/*`,
                auditTable.tableArn, `${auditTable.tableArn}/index/*`
            ],
        }));

        // Cross-account assume role permissions
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ['sts:AssumeRole'],
            resources: [
                `arn:aws:iam::*:role/${CROSS_ACCOUNT_ROLE_NAME}`,
                `arn:aws:iam::*:role/NucleusAccess-*`
            ],
        }));

        // SNS permissions
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ['sns:Publish'],
            resources: [snsTopic.topicArn],
        }));

        // Lambda function with Node.js runtime and automatic TypeScript bundling
        const lambdaFunction = new lambda_nodejs.NodejsFunction(this, `${appName}-SchedulerLambda`, {
            functionName: `${stackName}-function`,
            runtime: lambda.Runtime.NODEJS_20_X,
            architecture: lambda.Architecture.ARM_64,
            entry: path.join(__dirname, '../lambda/scheduler/src/index.ts'),
            handler: 'handler',
            bundling: {
                externalModules: ['@aws-sdk/*'],
                minify: true,
                sourceMap: false,
            },
            environment: {
                APP_TABLE_NAME: appTable.tableName,
                AUDIT_TABLE_NAME: auditTable.tableName,
                CROSS_ACCOUNT_ROLE_ARN: lambdaRole.roleArn,
                SCHEDULER_TAG: SCHEDULER_TAG,
                SNS_TOPIC_ARN: snsTopic.topicArn,
                HUB_ACCOUNT_ID: this.account,
                NEXT_PUBLIC_HUB_ACCOUNT_ID: this.account,
            },
            role: lambdaRole,
            timeout: cdk.Duration.minutes(15),
            memorySize: 1024,
        });

        this.schedulerLambdaFunctionArn = lambdaFunction.functionArn;
        snsTopic.grantPublish(lambdaFunction);

        // EventBridge Rule
        const rule = new events.Rule(this, `${appName}-SchedulerTriggerRule`, {
            ruleName: `${stackName}-rule`,
            schedule: events.Schedule.expression(this.generateScheduleExpressionIST(SCHEDULE_INTERVAL)),
        });
        rule.addTarget(new targets.LambdaFunction(lambdaFunction));

        // ============================================================================
        // COGNITO AUTHENTICATION (from webUIStack.ts)
        // ============================================================================

        let appUrl = 'http://localhost:3000';
        if (customDomainConfig?.enableCustomDomain && customDomainConfig?.domainName) {
            appUrl = `https://${customDomainConfig.domainName}`;
        } else if (customDomainConfig?.fallbackDomainName) {
            appUrl = customDomainConfig.fallbackDomainName;
        }

        this.userPool = new cognito.UserPool(this, `${appName}-WebUIUserPool`, {
            userPoolName: `${webUiStackName}-user-pool`,
            selfSignUpEnabled: true,
            signInAliases: { email: true, username: false },
            standardAttributes: {
                email: { required: true, mutable: true },
                fullname: { required: false, mutable: true },
                givenName: { required: false, mutable: true },
                familyName: { required: false, mutable: true }
            },
            passwordPolicy: {
                minLength: 8,
                requireDigits: true,
                requireLowercase: true,
                requireSymbols: false,
                requireUppercase: false,
                tempPasswordValidity: cdk.Duration.days(7),
            },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            autoVerify: { email: true },
            signInCaseSensitive: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        new cognito.UserPoolDomain(this, `${appName}-WebUIUserPoolDomain`, {
            userPool: this.userPool,
            cognitoDomain: { domainPrefix: `${webUiStackName}-auth-${this.account}` },
        });

        this.userPoolClient = new cognito.UserPoolClient(this, `${appName}-WebUIUserPoolClient`, {
            userPool: this.userPool,
            userPoolClientName: `${webUiStackName}-app-client`,
            generateSecret: true,
            authFlows: { userPassword: true, userSrp: true },
            oAuth: {
                flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
                scopes: [
                    cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.PROFILE, cognito.OAuthScope.COGNITO_ADMIN
                ],
                callbackUrls: [
                    'http://localhost:3000/api/auth/callback/cognito',
                    `${appUrl}/api/auth/callback/cognito`,
                ],
                logoutUrls: ['http://localhost:3000', appUrl],
            },
            preventUserExistenceErrors: true,
            enableTokenRevocation: true,
            accessTokenValidity: cdk.Duration.hours(1),
            idTokenValidity: cdk.Duration.hours(1),
            refreshTokenValidity: cdk.Duration.days(30),
        });

        this.identityPool = new cognito.CfnIdentityPool(this, `${appName}-WebUIIdentityPool`, {
            identityPoolName: `${webUiStackName}-identity-pool`,
            allowUnauthenticatedIdentities: false,
            cognitoIdentityProviders: [{
                clientId: this.userPoolClient.userPoolClientId,
                providerName: this.userPool.userPoolProviderName,
            }],
        });

        const authenticatedRole = new iam.Role(this, `${appName}-WebUIAuthenticatedRole`, {
            assumedBy: new iam.FederatedPrincipal(
                'cognito-identity.amazonaws.com',
                {
                    'StringEquals': { 'cognito-identity.amazonaws.com:aud': this.identityPool.ref },
                    'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
                },
                'sts:AssumeRoleWithWebIdentity'
            ),
            roleName: `${webUiStackName}-authenticated-role`,
        });

        new cognito.CfnIdentityPoolRoleAttachment(this, `${appName}-WebUIIdentityPoolRoleAttachment`, {
            identityPoolId: this.identityPool.ref,
            roles: { 'authenticated': authenticatedRole.roleArn },
        });

        authenticatedRole.addToPolicy(new iam.PolicyStatement({
            actions: ['mobileanalytics:PutEvents', 'cognito-sync:*', 'cognito-identity:*'],
            resources: ['*'],
        }));
        authenticatedRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
                'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:DeleteItem',
            ],
            resources: [
                usersTeamsTable.tableArn, `${usersTeamsTable.tableArn}/index/*`,
                appTable.tableArn, `${appTable.tableArn}/index/*`,
            ],
        }));

        // ============================================================================
        // ECS SERVICE FOR WEB UI
        // ============================================================================

        // ECS Task Execution Role
        const ecsTaskExecutionRole = new iam.Role(this, `${appName}-EcsTaskExecutionRole`, {
            roleName: `${webUiStackName}-ecs-task-execution-role`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });

        ecsTaskExecutionRole.addToPolicy(new iam.PolicyStatement({
            actions: ['ecr:GetAuthorizationToken', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
            resources: ['*'],
        }));

        // ECS Task Role
        const ecsTaskRole = new iam.Role(this, `${appName}-EcsTaskRole`, {
            roleName: `${webUiStackName}-ecs-task-role`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        // DynamoDB permissions for ECS task
        ecsTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
                'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:DeleteItem',
                'dynamodb:BatchWriteItem', 'dynamodb:BatchGetItem', 'dynamodb:DescribeTable',
                'dynamodb:TransactWriteItems',
            ],
            resources: [
                appTable.tableArn, `${appTable.tableArn}/index/*`,
                auditTable.tableArn, `${auditTable.tableArn}/index/*`,
                usersTeamsTable.tableArn, `${usersTeamsTable.tableArn}/index/*`,
                checkpointTable.tableArn, `${checkpointTable.tableArn}/index/*`,
                writesTable.tableArn, `${writesTable.tableArn}/index/*`,
                agentConversationsTable.tableArn, `${agentConversationsTable.tableArn}/index/*`,
                chatHistoryTable.tableArn, `${chatHistoryTable.tableArn}/index/*`,
                memoryTable.tableArn, `${memoryTable.tableArn}/index/*`,
                inventoryTable.tableArn, `${inventoryTable.tableArn}/index/*`,
                agentOpsTable.tableArn, `${agentOpsTable.tableArn}/index/*`,
            ],
        }));

        // Bedrock permissions for embeddings (long-term memory semantic search)
        ecsTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
        }));

        // STS permissions
        ecsTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'sts:AssumeRole', 'sts:GetCallerIdentity', 'sts:GetSessionToken',
                'sts:AssumeRoleWithWebIdentity', 'sts:GetAccessKeyInfo'
            ],
            resources: ['*', 'arn:aws:iam::*:role/NucleusAccess-*', `arn:aws:iam::${this.account}:role/*${appName}*`],
        }));

        // S3 permissions
        ecsTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
            resources: ['arn:aws:s3:::*'],
        }));

        // Grant access to checkpoint bucket
        checkpointBucket.grantReadWrite(ecsTaskRole);

        // Bedrock permissions
        ecsTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:ListFoundationModels'],
            resources: ['*'],
        }));

        // AWS Marketplace permissions (for marketplace Bedrock models)
        ecsTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
            resources: ['*'],
        }));

        // EventBridge permissions
        ecsTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['events:DescribeRule', 'events:PutRule', 'events:ListRules'],
            resources: [`arn:aws:events:${this.region}:${this.account}:rule/${appName}-rule`],
        }));

        // Cognito permissions
        ecsTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'cognito-idp:AdminGetUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminCreateUser',
                'cognito-idp:AdminDeleteUser', 'cognito-idp:AdminUpdateUserAttributes', 'cognito-idp:AdminListUsers',
                'cognito-idp:AdminListGroups', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup',
                'cognito-idp:ListUsers'
            ],
            resources: [this.userPool.userPoolArn],
        }));

        // Lambda invoke permission
        ecsTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: [lambdaFunction.functionArn],
        }));

        // ECS Cluster
        const ecsCluster = new ecs.Cluster(this, `${appName}-WebUIEcsCluster`, {
            clusterName: `${appName}-ecs-cluster`,
            vpc: props.vpc,
        });
        this.ecsClusterName = ecsCluster.clusterName;
        ecsCluster.enableFargateCapacityProviders();

        // Log Group
        const webUiLogGroup = new logs.LogGroup(this, `${appName}-WebUILogGroup`, {
            logGroupName: `/ecs/${webUiStackName}-service`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Task Definition
        const webUiCpu = ecsConfig.webUi?.cpu || 512;
        const webUiMemory = ecsConfig.webUi?.memory || 1024;

        const taskDef = new ecs.FargateTaskDefinition(this, `${appName}-WebUITaskDef`, {
            family: `${webUiStackName}-task`,
            executionRole: ecsTaskExecutionRole,
            taskRole: ecsTaskRole,
            cpu: webUiCpu,
            memoryLimitMiB: webUiMemory,
            runtimePlatform: {
                cpuArchitecture: ecs.CpuArchitecture.ARM64,
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
            },
        });

        const containerImage = ecs.ContainerImage.fromAsset(
            path.join(__dirname, "../web-ui"),
            { file: "Dockerfile.ecs", platform: ecr_assets.Platform.LINUX_ARM64 }
        );

        taskDef.addContainer('WebUIContainer', {
            image: containerImage,
            logging: ecs.LogDriver.awsLogs({
                logGroup: webUiLogGroup,
                streamPrefix: 'web-ui',
            }),
            // healthCheck: {
            //     command: ['CMD-SHELL', 'curl -f http://127.0.0.1:3000/api/health || exit 1'],
            //     interval: cdk.Duration.seconds(60),
            //     timeout: cdk.Duration.seconds(10),
            //     retries: 5,
            //     startPeriod: cdk.Duration.seconds(120),
            // },
            environment: {
                NODE_ENV: 'production',
                PORT: '3000',
                AWS_REGION: this.region,
                NEXT_PUBLIC_AWS_REGION: this.region,
                NEXT_PUBLIC_HUB_ACCOUNT_ID: this.account,
                HUB_ACCOUNT_ID: this.account,
                APP_TABLE_NAME: appTable.tableName,
                NEXT_PUBLIC_APP_TABLE_NAME: appTable.tableName,
                AUDIT_TABLE_NAME: auditTable.tableName,
                NEXT_PUBLIC_AUDIT_TABLE_NAME: auditTable.tableName,
                DYNAMODB_CHECKPOINT_TABLE: checkpointTableName,
                DYNAMODB_WRITES_TABLE: writesTableName,
                CHECKPOINT_S3_BUCKET: checkpointBucket.bucketName,
                DYNAMODB_CHAT_HISTORY_TABLE: chatHistoryTableName,
                DYNAMODB_MEMORY_TABLE: memoryTableName,
                DYNAMODB_USERS_TEAMS_TABLE: usersTeamsTable.tableName,
                COGNITO_USER_POOL_ID: this.userPool.userPoolId,
                NEXT_PUBLIC_COGNITO_USER_POOL_ID: this.userPool.userPoolId,
                COGNITO_USER_POOL_CLIENT_ID: this.userPoolClient.userPoolClientId,
                NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID: this.userPoolClient.userPoolClientId,
                COGNITO_CLIENT_SECRET: this.userPoolClient.userPoolClientSecret?.unsafeUnwrap() || '',
                COGNITO_DOMAIN: `${webUiStackName}-auth-${this.account}.auth.${this.region}.amazoncognito.com`,

                // Vector Search Config
                VECTOR_BUCKET_NAME: vectorBucket.vectorBucketName,
                VECTOR_INDEX_NAME: vectorIndex.indexName,
                BEDROCK_MODEL_ID: "amazon.titan-embed-text-v2:0",

                // Remaining Cognito & App Config
                NEXT_PUBLIC_COGNITO_DOMAIN: `${webUiStackName}-auth-${this.account}.auth.${this.region}.amazoncognito.com`,
                COGNITO_REGION: this.region,
                NEXT_PUBLIC_COGNITO_REGION: this.region,
                COGNITO_IDENTITY_POOL_ID: this.identityPool.ref,
                NEXT_PUBLIC_COGNITO_IDENTITY_POOL_ID: this.identityPool.ref,
                NEXTAUTH_URL: appUrl,
                NEXT_PUBLIC_NEXTAUTH_URL: appUrl,
                NEXTAUTH_SECRET: 'web-ui-nextauth-secret-change-in-production-or-use-secrets',
                COGNITO_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
                NEXT_PUBLIC_COGNITO_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
                AWS_LAMBDA_EXECUTION_ROLE_ARN: ecsTaskRole.roleArn,
                NEXT_PUBLIC_AWS_LAMBDA_EXECUTION_ROLE_ARN: ecsTaskRole.roleArn,
                AWS_USE_STS: 'true',
                NEXT_PUBLIC_AWS_USE_STS: 'true',
                COGNITO_APP_CLIENT_ID: this.userPoolClient.userPoolClientId,
                COGNITO_APP_CLIENT_SECRET: this.userPoolClient.userPoolClientSecret?.unsafeUnwrap() || '',
                DATA_DIR: '/tmp',
                SCHEDULER_LAMBDA_ARN: lambdaFunction.functionArn,
                EVENTBRIDGE_RULE_NAME: `${appName}-rule`,
                AGENT_TEMP_BUCKET: agentTempBucket.bucketName,
                DYNAMODB_AGENT_CONVERSATIONS_TABLE: agentConversationsTable.tableName,
                AGENT_OPS_TABLE_NAME: agentOpsTable.tableName,
                // DocumentDB (MongoDB-compatible)
                DOCDB_ENDPOINT: docDbEndpoint,
                DOCDB_PORT: String(docDbPort),
                MONGODB_URI: `mongodb://nucleusadmin:REPLACE_WITH_SECRET@${docDbEndpoint}:${docDbPort}/?tls=true&tlsCAFile=/etc/ssl/certs/rds-combined-ca-bundle.pem&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false`,
                MONGODB_DB_NAME: `${appName.replace(/-/g, '_')}_db`,

                // Langfuse Observability (LLM tracing for the AI agent)
                LANGFUSE_ENABLED: process.env.LANGFUSE_ENABLED || 'false',
                LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY || '',
                LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY || '',
                LANGFUSE_HOST: process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com',
            },
            secrets: {
                // Inject DocumentDB credentials from Secrets Manager at runtime
                DOCDB_USERNAME: ecs.Secret.fromSecretsManager(docDbSecret, 'username'),
                DOCDB_PASSWORD: ecs.Secret.fromSecretsManager(docDbSecret, 'password'),
            },
            portMappings: [{ containerPort: 3000, hostPort: 3000, protocol: ecs.Protocol.TCP }],
        });

        // Grant ECS task role permission to read DocumentDB secret
        ecsTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [docDbSecret.secretArn],
        }));
        ecsTaskExecutionRole.addToPolicy(new iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [docDbSecret.secretArn],
        }));

        // Grant S3 Vectors permissions to ECS Task Role
        ecsTaskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "s3vectors:QueryVectors",
                "s3vectors:PutVectors",
                "s3vectors:GetVector",
                "s3vectors:ListVectorIndices"
            ],
            resources: [
                vectorBucket.vectorBucketArn,
                `${vectorBucket.vectorBucketArn}/*`,
                vectorIndex.indexArn
            ]
        }));

        // Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, `${appName}-WebUIAlb`, {
            vpc: props.vpc,
            internetFacing: true,
            loadBalancerName: `${appName}-alb`,
            idleTimeout: cdk.Duration.seconds(1200), // 20 minutes to support long streaming requests
        });

        // ECS Service
        const desiredCount = ecsConfig.webUi?.desiredCount || 0;
        const service = new ecs.FargateService(this, `${appName}-WebUIService`, {
            cluster: ecsCluster,
            taskDefinition: taskDef,
            desiredCount: desiredCount,
            serviceName: `${webUiStackName}-service`,
            circuitBreaker: { rollback: true },
            minHealthyPercent: 100,
            maxHealthyPercent: 200,
        });
        this.webUiServiceName = service.serviceName;

        // Target Group
        const targetGroup = new elbv2.ApplicationTargetGroup(this, `${appName}-WebUITargetGroup`, {
            vpc: props.vpc,
            port: 3000,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            deregistrationDelay: cdk.Duration.seconds(30),
            healthCheck: {
                path: '/api/health',
                interval: cdk.Duration.seconds(60),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
            },
        });
        targetGroup.addTarget(service);


        // ALB Listener HTTP
        alb.addListener('HttpListener', {
            port: 80,
            defaultTargetGroups: [targetGroup],
        });
        this.webUiLoadBalancerUrl = `http://${alb.loadBalancerDnsName}`;

        // // Listener (HTTP or HTTPS)
        // if (customDomainConfig?.certificateArn && customDomainConfig?.enableCustomDomain) {
        //     const certificate = acm.Certificate.fromCertificateArn(this, `${appName}-AlbCertificate`, customDomainConfig.certificateArn);
        //     alb.addListener('HttpsListener', {
        //         port: 443,
        //         protocol: elbv2.ApplicationProtocol.HTTPS,
        //         certificates: [certificate],
        //         defaultTargetGroups: [targetGroup],
        //     });
        //     alb.addRedirect({ sourceProtocol: elbv2.ApplicationProtocol.HTTP, targetProtocol: elbv2.ApplicationProtocol.HTTPS });
        //     this.webUiLoadBalancerUrl = `https://${alb.loadBalancerDnsName}`;
        // } else {
        //     alb.addListener('HttpListener', {
        //         port: 80,
        //         defaultTargetGroups: [targetGroup],
        //     });
        //     this.webUiLoadBalancerUrl = `http://${alb.loadBalancerDnsName}`;
        // }

        // Auto Scaling
        const scaling = service.autoScaleTaskCount({
            minCapacity: ecsConfig.webUi?.minCapacity || 2,
            maxCapacity: ecsConfig.webUi?.maxCapacity || 10,
        });
        scaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 70 });
        scaling.scaleOnMemoryUtilization('MemoryScaling', { targetUtilizationPercent: 75 });

        // ============================================================================
        // DISCOVERY ECS TASK (Auto-Discovery Feature)
        // ============================================================================

        // Discovery Task Definition
        const discoveryTaskDef = new ecs.FargateTaskDefinition(this, `${appName}-DiscoveryTaskDef`, {
            family: `${appName}-discovery-task`,
            executionRole: ecsTaskExecutionRole,
            taskRole: discoveryTaskRole,
            cpu: 1024,
            memoryLimitMiB: 2048,
            runtimePlatform: {
                cpuArchitecture: ecs.CpuArchitecture.ARM64,
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
            },
        });

        // Discovery container image from local Dockerfile
        const discoveryImage = ecs.ContainerImage.fromAsset(
            path.join(__dirname, '../lambda/discovery'),
            { platform: ecr_assets.Platform.LINUX_ARM64 }
        );

        discoveryTaskDef.defaultContainer?.addEnvironment('S3_TABLE_BUCKET_ARN', tableBucket.tableBucketArn);
        discoveryTaskDef.defaultContainer?.addEnvironment('S3_TABLE_NAMESPACE', 'nucleus');

        discoveryTaskDef.addContainer('DiscoveryContainer', {
            image: discoveryImage,
            logging: ecs.LogDriver.awsLogs({
                logGroup: discoveryLogGroup,
                streamPrefix: 'discovery',
            }),
            environment: {
                APP_TABLE_NAME: appTable.tableName,
                INVENTORY_TABLE_NAME: inventoryTable.tableName,
                INVENTORY_BUCKET: inventoryBucket.bucketName,
                AWS_REGION: this.region,
            },
        });


        // Security Group for Discovery Task
        const discoverySg = new ec2.SecurityGroup(this, `${appName}-DiscoverySG`, {
            vpc: props.vpc,
            description: 'Security Group for AWS Auto-Discovery ECS Task',
            allowAllOutbound: true, // Allow outbound access for AWS API calls
        });

        // EventBridge Scheduler Role for triggering ECS tasks
        const schedulerRole = new iam.Role(this, `${appName}-DiscoverySchedulerRole`, {
            roleName: `${appName}-discovery-scheduler-role`,
            assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
        });

        schedulerRole.addToPolicy(new iam.PolicyStatement({
            actions: ['ecs:RunTask'],
            resources: [discoveryTaskDef.taskDefinitionArn],
        }));

        schedulerRole.addToPolicy(new iam.PolicyStatement({
            actions: ['iam:PassRole'],
            resources: [
                ecsTaskExecutionRole.roleArn,
                discoveryTaskRole.roleArn,
            ],
        }));

        // EventBridge Scheduler for daily discovery (2:00 AM UTC)
        new cdk.CfnResource(this, `${appName}-DailyDiscoverySchedule`, {
            type: 'AWS::Scheduler::Schedule',
            properties: {
                Name: `${appName}-daily-discovery`,
                Description: 'Runs AWS resource discovery daily at 2:00 AM UTC',
                ScheduleExpression: 'cron(0 2 * * ? *)',
                FlexibleTimeWindow: { Mode: 'OFF' },
                State: 'ENABLED',
                Target: {
                    Arn: ecsCluster.clusterArn,
                    RoleArn: schedulerRole.roleArn,
                    EcsParameters: {
                        TaskDefinitionArn: discoveryTaskDef.taskDefinitionArn,
                        LaunchType: 'FARGATE',
                        NetworkConfiguration: {
                            AwsvpcConfiguration: {
                                Subnets: props.vpc.privateSubnets.map(s => s.subnetId),
                                SecurityGroups: [discoverySg.securityGroupId],
                                AssignPublicIp: 'DISABLED',
                            },
                        },
                        TaskCount: 1,
                    },
                },
            },
        });

        // EventBridge Rule to trigger Discovery ECS Task
        const discoveryRule = new events.Rule(this, `app-DiscoveryTriggerRule`, {
            ruleName: `${appName}-discovery-trigger-rule`,
            eventPattern: {
                source: ['nucleus.app'],
                detailType: ['StartDiscovery'],
            },
        });

        discoveryRule.addTarget(new targets.EcsTask({
            cluster: ecsCluster,
            taskDefinition: discoveryTaskDef,
            launchType: ecs.LaunchType.FARGATE,
            subnetSelection: { subnets: props.vpc.privateSubnets },
            securityGroups: [discoverySg],
            containerOverrides: [{
                containerName: 'DiscoveryContainer',
                environment: [
                    { name: 'SCAN_ID', value: events.EventField.fromPath('$.detail.scanId') },
                    { name: 'ACCOUNT_ID', value: events.EventField.fromPath('$.detail.accountId') },
                ],
            }],
        }));


        // ============================================================================
        // CLOUDFRONT DISTRIBUTION
        // ============================================================================

        // Generate a secret for origin verification (prevents direct ALB access)
        const originVerifySecret = crypto.randomBytes(32).toString('hex');

        // Create CloudFront distribution with ALB as origin
        let distribution: cloudfront.Distribution;

        if (customDomainConfig?.enableCustomDomain && customDomainConfig?.domainName && customDomainConfig?.certificateArn) {
            // Custom domain enabled - create distribution with custom domain
            const cloudfrontCertificate = acm.Certificate.fromCertificateArn(
                this,
                `${appName}-CloudFrontCertificate`,
                customDomainConfig.certificateArn
            );

            distribution = new cloudfront.Distribution(this, `${appName}-WebUIDistribution`, {
                comment: `${appName} Web UI CloudFront Distribution`,
                domainNames: [customDomainConfig.domainName],
                certificate: cloudfrontCertificate,
                defaultBehavior: {
                    origin: new origins.HttpOrigin(alb.loadBalancerDnsName, {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                        readTimeout: cdk.Duration.seconds(60), // Maximum default (180s requires AWS support limit increase)
                        connectionTimeout: cdk.Duration.seconds(10), // Maximum allowed by CloudFront
                        customHeaders: {
                            'X-Origin-Verify': originVerifySecret,
                        },
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // Dynamic Next.js content
                    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
                },
                priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // Use only North America and Europe edge locations
                httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
                minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            });

            this.webUiUrl = `https://${customDomainConfig.domainName}`;
        } else {
            // No custom domain - use CloudFront default domain
            distribution = new cloudfront.Distribution(this, `${appName}-WebUIDistribution`, {
                comment: `${appName} Web UI CloudFront Distribution`,
                defaultBehavior: {
                    origin: new origins.HttpOrigin(alb.loadBalancerDnsName, {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
                        readTimeout: cdk.Duration.seconds(60), // Maximum default (180s requires AWS support limit increase)
                        connectionTimeout: cdk.Duration.seconds(10), // Maximum allowed by CloudFront
                        customHeaders: {
                            'X-Origin-Verify': originVerifySecret,
                        },
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // Dynamic Next.js content
                    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
                },
                priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
                httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            });

            this.webUiUrl = `https://${distribution.distributionDomainName}`;
        }

        this.cloudFrontDistributionId = distribution.distributionId;
        this.cloudFrontDomainName = distribution.distributionDomainName;

        // ============================================================================
        // STACK OUTPUTS
        // ============================================================================

        new cdk.CfnOutput(this, 'SchedulerLambdaFunctionName', { value: lambdaFunction.functionName });
        new cdk.CfnOutput(this, 'SchedulerLambdaFunctionArn', { value: lambdaFunction.functionArn });
        new cdk.CfnOutput(this, 'AppTableName', { value: appTable.tableName });
        new cdk.CfnOutput(this, 'AuditTableName', { value: auditTable.tableName });
        new cdk.CfnOutput(this, 'SNSTopicArn', { value: snsTopic.topicArn });
        new cdk.CfnOutput(this, 'EventBridgeRuleName', { value: rule.ruleName });
        new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: this.userPool.userPoolId });
        new cdk.CfnOutput(this, 'CognitoUserPoolClientId', { value: this.userPoolClient.userPoolClientId });
        new cdk.CfnOutput(this, 'CognitoIdentityPoolId', { value: this.identityPool.ref });
        new cdk.CfnOutput(this, 'EcsClusterName', { value: ecsCluster.clusterName });
        new cdk.CfnOutput(this, 'WebUIServiceName', { value: service.serviceName });
        new cdk.CfnOutput(this, 'WebUILoadBalancerUrl', { value: this.webUiLoadBalancerUrl });
        new cdk.CfnOutput(this, 'WebUILoadBalancerArn', { value: alb.loadBalancerArn });
        new cdk.CfnOutput(this, 'CloudFrontDistributionId', { value: distribution.distributionId });
        new cdk.CfnOutput(this, 'CloudFrontDomainName', { value: distribution.distributionDomainName });
        new cdk.CfnOutput(this, 'WebUIUrl', {
            value: this.webUiUrl,
            description: 'Primary URL for accessing the Web UI (via CloudFront)',
        });
        new cdk.CfnOutput(this, 'OriginVerifySecret', {
            value: originVerifySecret,
            description: 'Secret header value for origin verification (for ALB configuration)',
        });
        new cdk.CfnOutput(this, 'CheckpointBucketName', {
            value: checkpointBucket.bucketName,
            description: 'S3 Bucket for LangGraph Checkpoint Offloading',
        });

        // Grant access to agent temp bucket
        agentTempBucket.grantReadWrite(ecsTaskRole);

        new cdk.CfnOutput(this, 'AgentTempBucketName', {
            value: agentTempBucket.bucketName,
            description: 'S3 Bucket for Agent Temporary Storage',
        });

        // Grant web UI access to inventory bucket (for export downloads)
        inventoryBucket.grantRead(ecsTaskRole);

        // Discovery infrastructure outputs
        new cdk.CfnOutput(this, 'InventoryTableName', {
            value: inventoryTable.tableName,
            description: 'DynamoDB Table for Auto-Discovery inventory data',
        });
        new cdk.CfnOutput(this, 'InventoryBucketName', {
            value: inventoryBucket.bucketName,
            description: 'S3 Bucket for Auto-Discovery inventory data',
        });
        new cdk.CfnOutput(this, 'DiscoveryTaskDefinitionArn', {
            value: discoveryTaskDef.taskDefinitionArn,
            description: 'ECS Task Definition ARN for Discovery task',
        });

        // DocumentDB outputs
        new cdk.CfnOutput(this, 'DocDbClusterEndpoint', {
            value: docDbEndpoint,
            description: 'DocumentDB cluster endpoint',
        });
        new cdk.CfnOutput(this, 'DocDbPort', {
            value: String(docDbPort),
            description: 'DocumentDB port',
        });
        new cdk.CfnOutput(this, 'DocDbSecretArn', {
            value: docDbSecret.secretArn,
            description: 'ARN of the DocumentDB credentials secret',
        });
        new cdk.CfnOutput(this, 'DocDbConnectionStringSecretArn', {
            value: connectionStringSecret.secretArn,
            description: 'ARN of the DocumentDB connection string secret',
        });
    }



    private generateScheduleExpressionIST(interval: number): string {
        switch (interval) {
            case 5: return 'cron(0/5 * * * ? *)';
            case 15: return 'cron(0,15,30,45 * * * ? *)';
            case 30: return 'cron(0,30 * * * ? *)';
            case 60: return 'cron(30 * * * ? *)';
            default: throw new Error(`Invalid schedule interval: ${interval}`);
        }
    }
}

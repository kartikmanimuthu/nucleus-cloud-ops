import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambda from "aws-cdk-lib/aws-lambda";
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
import { Construct } from "constructs";
import { RemovalPolicy } from "aws-cdk-lib";

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
        // CONFIGURATION FROM CONTEXT
        // ============================================================================

        const appName = this.node.tryGetContext('appName') || 'nucleus-app';
        const SCHEDULE_INTERVAL = 30; // Defaulting to 30 as context is being removed
        const CROSS_ACCOUNT_ROLE_NAME = 'CrossAccountRoleForCostOptimizationScheduler';
        const SCHEDULER_TAG = 'cost-optimization-scheduler';
        const subscriptionEmails = this.node.tryGetContext('subscriptionEmails') || [];
        const customDomainConfig = this.node.tryGetContext('customDomain') || {};
        const ecsConfig = this.node.tryGetContext('ecs') || {};

        const stackName = `${appName}`;
        const webUiStackName = `${appName}-web-ui`;

        // Table names
        const appTableName = `${stackName}-app-table`;
        const auditTableName = `${stackName}-audit-table`;
        const checkpointTableName = `${appName}-checkpoints-table`;
        const writesTableName = `${appName}-checkpoint-writes-v2-table`;

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
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // LangGraph Writes Table
        const writesTable = new dynamodb.Table(this, `${appName}-WritesTable`, {
            tableName: writesTableName,
            partitionKey: { name: 'thread_id_checkpoint_id_checkpoint_ns', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'task_id_idx', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
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

        const lambdaFunction = new lambda.Function(this, `${appName}-SchedulerLambda`, {
            functionName: `${stackName}-function`,
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'dist/index.handler',
            code: lambda.Code.fromAsset('lambda/scheduler'),
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
                'dynamodb:BatchWriteItem', 'dynamodb:BatchGetItem',
            ],
            resources: [
                appTable.tableArn, `${appTable.tableArn}/index/*`,
                auditTable.tableArn, `${auditTable.tableArn}/index/*`,
                usersTeamsTable.tableArn, `${usersTeamsTable.tableArn}/index/*`,
                checkpointTable.tableArn, `${checkpointTable.tableArn}/index/*`,
                writesTable.tableArn, `${writesTable.tableArn}/index/*`,
            ],
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
                cpuArchitecture: ecs.CpuArchitecture.X86_64,
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
            },
        });

        const containerImage = ecs.ContainerImage.fromAsset(
            path.join(__dirname, "../web-ui"),
            { file: "Dockerfile.ecs", platform: ecr_assets.Platform.LINUX_AMD64 }
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
                DYNAMODB_USERS_TEAMS_TABLE: usersTeamsTable.tableName,
                COGNITO_USER_POOL_ID: this.userPool.userPoolId,
                NEXT_PUBLIC_COGNITO_USER_POOL_ID: this.userPool.userPoolId,
                COGNITO_USER_POOL_CLIENT_ID: this.userPoolClient.userPoolClientId,
                NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID: this.userPoolClient.userPoolClientId,
                COGNITO_CLIENT_SECRET: this.userPoolClient.userPoolClientSecret?.unsafeUnwrap() || '',
                COGNITO_DOMAIN: `${webUiStackName}-auth-${this.account}.auth.${this.region}.amazoncognito.com`,
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
            },
            portMappings: [{ containerPort: 3000, hostPort: 3000, protocol: ecs.Protocol.TCP }],
        });

        // Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, `${appName}-WebUIAlb`, {
            vpc: props.vpc,
            internetFacing: true,
            loadBalancerName: `${appName}-alb`,
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

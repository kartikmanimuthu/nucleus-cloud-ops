import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as path from "path";
import { Construct } from "constructs";
import { RemovalPolicy } from "aws-cdk-lib";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

interface WebUIStackProps extends cdk.StackProps {
    schedulerLambdaArn?: string;
}

export class WebUIStack extends cdk.Stack {
    public readonly webUiUrl: string;
    public readonly webUiLambdaFunctionName: string;
    public readonly userPool: cognito.UserPool;
    public readonly userPoolClient: cognito.UserPoolClient;
    public readonly identityPool: cognito.CfnIdentityPool;

    constructor(scope: Construct, id: string, props?: WebUIStackProps) {
        super(scope, id, props);

        // Context and Configuration
        const appName = this.node.tryGetContext('appName') || 'nucleus-app';
        const SCHEDULER_NAME = appName;
        const stackName = `${SCHEDULER_NAME}-web-ui`;
        const customDomainConfig = this.node.tryGetContext('customDomain');

        // New Table Names
        const appTableName = `${SCHEDULER_NAME}-app-table`;
        const auditTableName = `${SCHEDULER_NAME}-audit-table`;
        const checkpointTableName = `${SCHEDULER_NAME}-checkpoints-table`;
        const writesTableName = `${SCHEDULER_NAME}-checkpoint-writes-v2-table`;
        const chatHistoryTableName = `${SCHEDULER_NAME}-chat-history`;
        const memoryTableName = `${SCHEDULER_NAME}-memory`;

        // ============================================================================
        // DYNAMODB TABLES
        // ============================================================================

        // Create DynamoDB table for users-teams (Keeping this as it might be used by the UI template still)
        const usersTeamsTable = new dynamodb.Table(this, 'UsersTeamsTable', {
            tableName: `${stackName}-users-teams`,
            partitionKey: {
                name: 'PK',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'SK',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Add Global Secondary Index for EntityType
        usersTeamsTable.addGlobalSecondaryIndex({
            indexName: 'EntityTypeIndex',
            partitionKey: {
                name: 'EntityType',
                type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // Create DynamoDB table for LangGraph checkpoints
        const checkpointTable = new dynamodb.Table(this, 'CheckpointTable', {
            tableName: checkpointTableName,
            partitionKey: { name: 'thread_id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'checkpoint_id', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create DynamoDB table for LangGraph writes
        const writesTable = new dynamodb.Table(this, 'WritesTable', {
            tableName: writesTableName,
            partitionKey: { name: 'thread_id_checkpoint_id_checkpoint_ns', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'task_id_idx', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Chat History Table (@farukada/aws-langgraph-dynamodb-ts DynamoDBChatMessageHistory)
        const chatHistoryTable = new dynamodb.Table(this, 'ChatHistoryTable', {
            tableName: chatHistoryTableName,
            partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Long-Term Memory Table (@farukada/aws-langgraph-dynamodb-ts DynamoDBStore)
        const memoryTable = new dynamodb.Table(this, 'MemoryTable', {
            tableName: memoryTableName,
            partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'namespace_key', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create S3 bucket for LangGraph large checkpoints
        const checkpointBucket = new s3.Bucket(this, 'CheckpointBucket', {
            bucketName: `${SCHEDULER_NAME}-checkpoints-bucket-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(30), // Auto-expire old checkpoints
                }
            ]
        });

        // ============================================================================
        // CREATE IAM ROLE FOR LAMBDA FUNCTION
        // ============================================================================

        // Lambda Execution Role - permissions for Lambda function
        const webUILambdaExecutionRole = new iam.Role(
            this,
            "WebUILambdaExecutionRole",
            {
                roleName: `${stackName}-lambda-execution-role`,
                assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
                description: "Execution role for Web UI Lambda function",
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName(
                        "service-role/AWSLambdaBasicExecutionRole"
                    ),
                ],
            }
        );

        // Add CloudWatch permissions for metrics and logs
        webUILambdaExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                    "cloudwatch:PutMetricData",
                ],
                resources: ["*"],
            })
        );

        // Add DynamoDB permissions for users-teams table
        webUILambdaExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "dynamodb:GetItem",
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:Query",
                    "dynamodb:Scan",
                    "dynamodb:DeleteItem",
                    "dynamodb:BatchWriteItem",
                    "dynamodb:BatchGetItem",
                ],
                resources: [
                    usersTeamsTable.tableArn,
                    `${usersTeamsTable.tableArn}/index/*`
                ],
            })
        );

        // Add DynamoDB permissions for Nucleus App and Audit tables
        webUILambdaExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "dynamodb:GetItem",
                    "dynamodb:Scan",
                    "dynamodb:Query",
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:DeleteItem",
                    "dynamodb:BatchWriteItem"
                ],
                resources: [
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${appTableName}`,
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${appTableName}/index/*`,
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${auditTableName}`,
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${auditTableName}/index/*`,
                ],
            })
        );

        // Add DynamoDB permissions for Checkpoint, Chat History, and Memory tables
        webUILambdaExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "dynamodb:GetItem",
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:DeleteItem",
                    "dynamodb:Query",
                    "dynamodb:BatchWriteItem",
                    "dynamodb:BatchGetItem",
                    "dynamodb:TransactWriteItems",
                ],
                resources: [
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${checkpointTableName}`,
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${checkpointTableName}/index/*`,
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${writesTableName}`,
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${writesTableName}/index/*`,
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${chatHistoryTableName}`,
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${chatHistoryTableName}/index/*`,
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${memoryTableName}`,
                    `arn:aws:dynamodb:${this.region}:${this.account}:table/${memoryTableName}/index/*`,
                ],
            })
        );

        // Bedrock permissions for embeddings (long-term memory semantic search)
        webUILambdaExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['bedrock:InvokeModel'],
                resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
            })
        );

        // Add STS permissions for the Lambda to assume roles and generate temporary credentials
        webUILambdaExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    "sts:AssumeRole",
                    "sts:GetCallerIdentity",
                    "sts:GetSessionToken",
                    "sts:AssumeRoleWithWebIdentity",
                    "sts:GetAccessKeyInfo"
                ],
                resources: [
                    "*",
                    "arn:aws:iam::*:role/NucleusAccess-*",
                    `arn:aws:iam::${this.account}:role/*${SCHEDULER_NAME}*`,
                ],
            })
        );

        // Add S3 permissions
        webUILambdaExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "s3:GetObject",
                    "s3:PutObject",
                    "s3:DeleteObject",
                    "s3:ListBucket",
                ],
                resources: [
                    `arn:aws:s3:::*`,
                ],
            })
        );

        // Grant Lambda access to the checkpoint bucket
        checkpointBucket.grantReadWrite(webUILambdaExecutionRole);

        // Add Bedrock permissions
        webUILambdaExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                    "bedrock:ListFoundationModels"
                ],
                resources: ["*"],
            })
        );

        // Add EventBridge permissions for scheduler settings management
        webUILambdaExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "events:DescribeRule",
                    "events:PutRule",
                    "events:ListRules"
                ],
                resources: [
                    `arn:aws:events:${this.region}:${this.account}:rule/${SCHEDULER_NAME}-rule`,
                ],
            })
        );

        // ============================================================================
        // COGNITO AUTHENTICATION SETUP
        // ============================================================================

        // Create a Cognito user pool for authentication
        this.userPool = new cognito.UserPool(this, 'WebUIUserPool', {
            userPoolName: `${stackName}-user-pool`,
            selfSignUpEnabled: true,
            signInAliases: {
                email: true,
                username: false
            },
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
            userVerification: {
                emailStyle: cognito.VerificationEmailStyle.CODE,
                emailBody: 'Your verification code is {####}',
                emailSubject: `Verify your email for ${SCHEDULER_NAME} Web UI`,
            },
            autoVerify: {
                email: true,
            },
            signInCaseSensitive: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Create a domain for the user pool
        const userPoolDomain = new cognito.UserPoolDomain(this, 'WebUIUserPoolDomain', {
            userPool: this.userPool,
            cognitoDomain: {
                domainPrefix: `${stackName}-auth-${this.account}`,
            },
        });

        // Determine the application URL
        let appUrl = 'http://localhost:3000';
        if (customDomainConfig?.enableCustomDomain && customDomainConfig?.domainName) {
            appUrl = `https://${customDomainConfig.domainName}`;
        } else if (customDomainConfig?.fallbackDomainName) {
            appUrl = customDomainConfig.fallbackDomainName;
        }

        // Cognito User Pool Client
        this.userPoolClient = new cognito.UserPoolClient(this, 'WebUIUserPoolClient', {
            userPool: this.userPool,
            userPoolClientName: `${stackName}-app-client`,
            generateSecret: true,
            authFlows: {
                userPassword: true,
                userSrp: true,
            },
            oAuth: {
                flows: {
                    authorizationCodeGrant: true,
                    implicitCodeGrant: false,
                },
                scopes: [
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.PROFILE,
                    cognito.OAuthScope.COGNITO_ADMIN
                ],
                callbackUrls: [
                    'http://localhost:3000/api/auth/callback/cognito',
                    `${appUrl}/api/auth/callback/cognito`,
                ],
                logoutUrls: [
                    'http://localhost:3000',
                    appUrl,
                ],
            },
            preventUserExistenceErrors: true,
            enableTokenRevocation: true,
            accessTokenValidity: cdk.Duration.hours(1),
            idTokenValidity: cdk.Duration.hours(1),
            refreshTokenValidity: cdk.Duration.days(30),
        });

        // Create a Cognito Identity Pool for AWS credentials (using L1 Construct)
        this.identityPool = new cognito.CfnIdentityPool(this, 'WebUIIdentityPool', {
            identityPoolName: `${stackName}-identity-pool`,
            allowUnauthenticatedIdentities: false,
            cognitoIdentityProviders: [{
                clientId: this.userPoolClient.userPoolClientId,
                providerName: this.userPool.userPoolProviderName,
            }],
        });

        // Create IAM role for authenticated users
        const authenticatedRole = new iam.Role(this, 'WebUIAuthenticatedRole', {
            assumedBy: new iam.FederatedPrincipal(
                'cognito-identity.amazonaws.com',
                {
                    'StringEquals': {
                        'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
                    },
                    'ForAnyValue:StringLike': {
                        'cognito-identity.amazonaws.com:amr': 'authenticated',
                    },
                },
                'sts:AssumeRoleWithWebIdentity'
            ),
            roleName: `${stackName}-authenticated-role`,
            description: 'Role for authenticated users of the Web UI',
        });

        // Attach Role to Identity Pool
        new cognito.CfnIdentityPoolRoleAttachment(this, 'WebUIIdentityPoolRoleAttachment', {
            identityPoolId: this.identityPool.ref,
            roles: {
                'authenticated': authenticatedRole.roleArn,
            },
        });

        // Add permissions for authenticated users
        authenticatedRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'mobileanalytics:PutEvents',
                'cognito-sync:*',
                'cognito-identity:*',
            ],
            resources: ['*'],
        }));

        // Add DynamoDB permissions for authenticated users
        authenticatedRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:Query',
                'dynamodb:Scan',
                'dynamodb:DeleteItem',
            ],
            resources: [
                usersTeamsTable.tableArn,
                `${usersTeamsTable.tableArn}/index/*`,
                `arn:aws:dynamodb:${this.region}:${this.account}:table/${appTableName}`,
                `arn:aws:dynamodb:${this.region}:${this.account}:table/${appTableName}/index/*`,
            ],
        }));

        // Add Cognito permissions to Lambda execution role
        webUILambdaExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "cognito-idp:AdminGetUser",
                    "cognito-idp:AdminSetUserPassword",
                    "cognito-idp:AdminCreateUser",
                    "cognito-idp:AdminDeleteUser",
                    "cognito-idp:AdminUpdateUserAttributes",
                    "cognito-idp:AdminListUsers",
                    "cognito-idp:AdminListGroups",
                    "cognito-idp:AdminAddUserToGroup",
                    "cognito-idp:AdminRemoveUserFromGroup",
                ],
                resources: [
                    cdk.Arn.format(
                        {
                            service: 'cognito-idp',
                            resource: 'userpool',
                            resourceName: this.userPool.userPoolId,
                        },
                        cdk.Stack.of(this),
                    ),
                ],
            })
        );

        // ============================================================================
        // WEB UI LAMBDA FUNCTION
        // ============================================================================

        // CloudWatch Log Group
        const logGroup = new logs.LogGroup(this, "WebUILogGroup", {
            logGroupName: `/aws/lambda/${stackName}-server`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Lambda function using Next.js Docker image/assets
        const webUILambdaFunction = new lambda.Function(this, "WebUILambdaFunction", {
            functionName: `${stackName}-server`,
            runtime: lambda.Runtime.FROM_IMAGE,
            handler: lambda.Handler.FROM_IMAGE,
            code: lambda.Code.fromAssetImage(path.join(__dirname, "../web-ui"), {
                cmd: ["sh", "-c", "exec node server.js"],
                platform: Platform.LINUX_ARM64,
            }),
            environment: {
                NODE_ENV: 'production',
                PORT: '8080',
                AWS_LWA_ENABLE_COMPRESSION: 'true',
                AWS_LWA_READINESS_CHECK_PROTOCOL: 'http',
                AWS_LWA_READINESS_CHECK_PORT: '8080',
                AWS_LWA_READINESS_CHECK_PATH: '/api/health',
                // AWS Configuration
                NEXT_PUBLIC_AWS_REGION: this.region,
                NEXT_PUBLIC_HUB_ACCOUNT_ID: this.account,
                HUB_ACCOUNT_ID: this.account,
                // DynamoDB Configuration
                APP_TABLE_NAME: appTableName,
                NEXT_PUBLIC_APP_TABLE_NAME: appTableName,
                AUDIT_TABLE_NAME: auditTableName,
                NEXT_PUBLIC_AUDIT_TABLE_NAME: auditTableName,
                DYNAMODB_CHECKPOINT_TABLE: checkpointTableName,
                DYNAMODB_WRITES_TABLE: writesTableName,
                CHECKPOINT_S3_BUCKET: checkpointBucket.bucketName,
                DYNAMODB_CHAT_HISTORY_TABLE: chatHistoryTableName,
                DYNAMODB_MEMORY_TABLE: memoryTableName,
                DYNAMODB_USERS_TEAMS_TABLE: usersTeamsTable.tableName,
                // Cognito Configuration for NextAuth
                COGNITO_USER_POOL_ID: this.userPool.userPoolId,
                NEXT_PUBLIC_COGNITO_USER_POOL_ID: this.userPool.userPoolId,
                COGNITO_USER_POOL_CLIENT_ID: this.userPoolClient.userPoolClientId,
                NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID: this.userPoolClient.userPoolClientId,
                COGNITO_CLIENT_SECRET: this.userPoolClient.userPoolClientSecret?.unsafeUnwrap() || '',
                COGNITO_DOMAIN: `${stackName}-auth-${this.account}.auth.${this.region}.amazoncognito.com`,
                NEXT_PUBLIC_COGNITO_DOMAIN: `${stackName}-auth-${this.account}.auth.${this.region}.amazoncognito.com`,
                COGNITO_REGION: this.region,
                NEXT_PUBLIC_COGNITO_REGION: this.region,
                // Identity Pool Configuration
                COGNITO_IDENTITY_POOL_ID: this.identityPool.ref,
                NEXT_PUBLIC_COGNITO_IDENTITY_POOL_ID: this.identityPool.ref,
                // Set NEXTAUTH_URL based on appUrl
                NEXTAUTH_URL: appUrl,
                NEXT_PUBLIC_NEXTAUTH_URL: appUrl,
                NEXTAUTH_SECRET: 'web-ui-nextauth-secret-change-in-production-or-use-secrets',
                // OAuth Configuration
                COGNITO_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
                NEXT_PUBLIC_COGNITO_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
                // STS Permissions
                AWS_LAMBDA_EXECUTION_ROLE_ARN: webUILambdaExecutionRole.roleArn,
                NEXT_PUBLIC_AWS_LAMBDA_EXECUTION_ROLE_ARN: webUILambdaExecutionRole.roleArn,
                AWS_USE_STS: 'true',
                NEXT_PUBLIC_AWS_USE_STS: 'true',
                // Cognito App Client credentials
                COGNITO_APP_CLIENT_ID: this.userPoolClient.userPoolClientId,
                COGNITO_APP_CLIENT_SECRET: this.userPoolClient.userPoolClientSecret?.unsafeUnwrap() || '',
                // Storage Configuration
                DATA_DIR: '/tmp',
                // Scheduler Lambda ARN for ad-hoc execution
                SCHEDULER_LAMBDA_ARN: props?.schedulerLambdaArn || '',
                // EventBridge rule name for scheduler settings
                EVENTBRIDGE_RULE_NAME: `${SCHEDULER_NAME}-rule`,
            },
            role: webUILambdaExecutionRole,
            timeout: cdk.Duration.seconds(300),
            memorySize: 2048,
            architecture: lambda.Architecture.ARM_64,
            logRetention: logs.RetentionDays.ONE_WEEK,
        });

        // Grant permission to invoke the Scheduler Lambda
        if (props?.schedulerLambdaArn) {
            webUILambdaExecutionRole.addToPolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['lambda:InvokeFunction'],
                resources: [props.schedulerLambdaArn],
            }));
        }

        this.webUiLambdaFunctionName = webUILambdaFunction.functionName;

        // ============================================================================
        // LAMBDA FUNCTION URL
        // ============================================================================

        const lambdaFunctionUrl = new lambda.FunctionUrl(this, 'WebUIFunctionUrl', {
            function: webUILambdaFunction,
            invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
            cors: {
                allowedHeaders: [
                    'Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key',
                    'X-Amz-Security-Token', 'X-Amz-User-Agent', 'Accept',
                    'Accept-Encoding', 'Cache-Control', 'X-Requested-With',
                    'Cookie', 'Set-Cookie',
                ],
                allowedMethods: [
                    lambda.HttpMethod.GET, lambda.HttpMethod.POST, lambda.HttpMethod.PUT,
                    lambda.HttpMethod.DELETE, lambda.HttpMethod.HEAD, lambda.HttpMethod.PATCH,
                ],
                allowedOrigins: ['*'],
                allowCredentials: false,
            },
            authType: lambda.FunctionUrlAuthType.NONE,
        });

        const functionUrl = lambdaFunctionUrl.url;

        // ============================================================================
        // CLOUDFRONT DISTRIBUTION
        // ============================================================================

        let distribution: cloudfront.Distribution;

        if (customDomainConfig?.enableCustomDomain && customDomainConfig?.domainName && customDomainConfig?.certificateArn) {
            distribution = new cloudfront.Distribution(this, 'WebUICustomDomain', {
                domainNames: [customDomainConfig.domainName],
                certificate: acm.Certificate.fromCertificateArn(this, 'WebUICustomDomainCertificate', customDomainConfig.certificateArn),
                defaultBehavior: {
                    origin: new origins.FunctionUrlOrigin(lambdaFunctionUrl),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                },
                priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            });
        } else {
            distribution = new cloudfront.Distribution(this, 'WebUIDistribution', {
                defaultBehavior: {
                    origin: new origins.FunctionUrlOrigin(lambdaFunctionUrl),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                },
                priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            });
        }

        const cloudfrontUrl = `https://${distribution.distributionDomainName}`;
        this.webUiUrl = cloudfrontUrl;

        // Apply removal policies
        (webUILambdaExecutionRole.node.defaultChild as cdk.CfnResource).applyRemovalPolicy(RemovalPolicy.DESTROY);
        (webUILambdaFunction.node.defaultChild as cdk.CfnResource).applyRemovalPolicy(RemovalPolicy.DESTROY);


        // ============================================================================
        // STACK OUTPUTS
        // ============================================================================

        new cdk.CfnOutput(this, "WebUILambdaFunctionName", {
            value: webUILambdaFunction.functionName,
            description: "Web UI Lambda Function Name",
        });

        new cdk.CfnOutput(this, "WebUILambdaFunctionUrl", {
            value: functionUrl,
            description: "Web UI Lambda Function URL",
        });

        new cdk.CfnOutput(this, "WebUIUrl", {
            value: cloudfrontUrl,
            description: "Web UI URL (CloudFront)",
        });

        if (customDomainConfig?.enableCustomDomain && customDomainConfig?.domainName) {
            new cdk.CfnOutput(this, "WebUICustomDomainUrl", {
                value: `https://${customDomainConfig.domainName}`,
                description: "Web UI Custom Domain URL",
            });
        }

        new cdk.CfnOutput(this, "WebUILambdaExecutionRoleArn", {
            value: webUILambdaExecutionRole.roleArn,
            description: "Web UI Lambda Execution Role ARN",
        });

        new cdk.CfnOutput(this, 'CognitoUserPoolId', {
            value: this.userPool.userPoolId,
            description: 'Cognito User Pool ID',
        });

        new cdk.CfnOutput(this, 'CognitoUserPoolClientId', {
            value: this.userPoolClient.userPoolClientId,
            description: 'Cognito User Pool Client ID',
        });

        new cdk.CfnOutput(this, 'CognitoUserPoolArn', {
            value: this.userPool.userPoolArn,
            description: 'Cognito User Pool ARN',
        });

        new cdk.CfnOutput(this, 'CognitoIdentityPoolId', {
            value: this.identityPool.ref,
            description: 'Cognito Identity Pool ID',
        });

        new cdk.CfnOutput(this, 'CognitoDomain', {
            value: `${stackName}-auth-${this.account}.auth.${this.region}.amazoncognito.com`,
            description: 'Cognito Domain',
        });

        new cdk.CfnOutput(this, 'UsersTeamsTableName', {
            value: usersTeamsTable.tableName,
            description: 'DynamoDB Table Name for Users and Teams',
        });

        // Output new tables
        new cdk.CfnOutput(this, 'AppTableName', {
            value: appTableName,
            description: 'Nucleus App Table Name',
        });

        new cdk.CfnOutput(this, 'AuditTableName', {
            value: auditTableName,
            description: 'Nucleus Audit Table Name',
        });

        new cdk.CfnOutput(this, 'CheckpointTableName', {
            value: checkpointTableName,
            description: 'LangGraph Checkpoint Table Name',
        });

        new cdk.CfnOutput(this, 'WritesTableName', {
            value: writesTableName,
            description: 'LangGraph Writes Table Name',
        });

        new cdk.CfnOutput(this, 'CheckpointBucketName', {
            value: checkpointBucket.bucketName,
            description: 'LangGraph S3 Checkpoint Bucket Name',
        });
    }
}

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
const crossAccountRoleName = "NucleusAccess";
const vectorBucketName = "";
const appName = config.get("appName") ?? "nucleus-cloud-ops";
const dbName = config.get("dbName") ?? "nucleus";
const dbUsername = config.get("dbUsername") ?? "nucleus_admin";
const engineVersion = config.get("engineVersion") ?? "16.6";
const workersDesiredCount = config.getNumber("workersDesiredCount") ?? 2;

// Optional resource-name suffix. Empty for a stack that has never set it —
// byte-for-byte the same names as if this key didn't exist.
const nameSuffix = config.get("networkSuffix") ?? "";
// Optional suffix appended to a handful of security-group descriptions.
// `description` is immutable on aws.ec2.SecurityGroup (no AWS API to modify
// it), so if a stack's live groups already carry descriptive text, that
// exact text must be supplied here — a mismatch forces a full SG replace.
// Config-driven rather than keyed off nameSuffix/the stack name, so this
// stays generic: whatever text (if any) is already live per stack.
const securityGroupDescriptionSuffix = config.get("securityGroupDescriptionSuffix") ?? "";

// Fargate Spot Guard — cross-account ECS event ingestion (EventBridge + SQS).
//
// Defaults to FALSE so this stays a no-op on every stack that has not opted in.
// Currently enabled on `sbx` only (nucleus-compute:spotGuardEnabled in
// Pulumi.sbx.yaml); enabling it on prod is a one-line config change, NOT a code
// change. Deliberately a config flag rather than `pulumi.getStack() === "sbx"`:
// the intent stays visible in the stack file, and a `pulumi preview --stack prod`
// proves the absence rather than relying on reading a branch correctly.
const spotGuardEnabled = config.getBoolean("spotGuardEnabled") ?? false;

// Scaling Audit (SA-001) — SEBI compliance capture of ECS + ASG scaling events.
// Same reasoning as spotGuardEnabled: defaults to FALSE so this is a no-op on
// every stack that has not opted in; enabling it is a one-line config change.
const scalingAuditEnabled = config.getBoolean("scalingAuditEnabled") ?? false;

// RBAC/ABAC rollout flags. Same config-flag reasoning as the two above: the
// defaults reproduce the safe values these were hardcoded to, so a stack that
// does not opt in is byte-for-byte unchanged. Set to true/enforce on `sbx` to
// run the soak described at the task-definition env entry below.
const dynamicAbacEnabled = config.getBoolean("dynamicAbacEnabled") ?? false;
const rbacRouteGuardMode = config.get("rbacRouteGuardMode") ?? "shadow";
const rbacPageGuardMode = config.get("rbacPageGuardMode") ?? "shadow";

// The bus name as a plain string, so both the EventBus resource (declared ~1200 lines
// below) and the web-ui task definition (declared above it) can derive from ONE source.
// The web-ui needs the bus ARN to bake into each customer's onboarding template, but the
// bus resource does not exist yet at that point in the file, so the ARN is composed from
// this name rather than read off `spotGuardBus.arn`. Keep the EventBus using this
// constant — that is what makes composing the ARN exact instead of a guess.
const spotGuardBusNameLiteral = `${appName}-spot-guard`;

// Dynamically generated — stored in AWS Secrets Manager, never in Pulumi config
const nextauthSecretRandom = new random.RandomPassword("nextauth-secret-random", {
    length: 32,
    special: false,
    keepers: { version: "1" },
});

const dbPasswordRandom = new random.RandomPassword("db-password-random", {
    length: 24,
    special: false,
    keepers: { version: "1" },
});

const nextauthSecretSm = new aws.secretsmanager.Secret("nextauth-secret", {
    name: `${appName}/nextauth-secret`,
    description: "NextAuth.js secret for JWT signing",
    recoveryWindowInDays: 0,
});

new aws.secretsmanager.SecretVersion("nextauth-secret-version", {
    secretId: nextauthSecretSm.id,
    secretString: nextauthSecretRandom.result,
});

// Shared secret authenticating the workers -> web-ui internal trigger endpoint
// (agent-ops scheduled tasks). Both services read the SAME value; there is no
// hardcoded fallback anymore, so this MUST be provisioned for scheduled agent
// tasks to run. Random per stack.
const internalApiKeyRandom = new random.RandomPassword("internal-api-key-random", {
    length: 48,
    special: false,
    keepers: { version: "1" },
});

const internalApiKeySm = new aws.secretsmanager.Secret("internal-api-key", {
    name: `${appName}/internal-api-key`,
    description: "Shared secret for workers -> web-ui internal API calls",
    recoveryWindowInDays: 0,
});

new aws.secretsmanager.SecretVersion("internal-api-key-version", {
    secretId: internalApiKeySm.id,
    secretString: internalApiKeyRandom.result,
});

const databaseUrlSm = new aws.secretsmanager.Secret("database-url", {
    name: `${appName}/database-url`,
    description: "Full PostgreSQL connection string for ECS tasks",
    recoveryWindowInDays: 0,
});

// database-url-version is created after postgresInstance (needs .address output)

const nextauthSecret = nextauthSecretRandom.result;
const dbPassword = dbPasswordRandom.result;

// Phase 7+: Networking stack is deployed — use requireOutput() to enforce dependency.
// requireOutput() throws at preview time if networking stack is not deployed,
// preventing silent undefined values from propagating into compute resources.

// StackReference to networking project.
// Format for S3 backend: "organization/<project>/<stack>" (literal "organization" required)
const networking = new pulumi.StackReference(`organization/nucleus-networking/${pulumi.getStack()}`);

// Networking outputs — all required (networking must be deployed before compute can preview)
const vpcId = networking.requireOutput("vpcId") as pulumi.Output<string>;
const vpcCidr = networking.requireOutput("vpcCidr") as pulumi.Output<string>;
const privateSubnetIds = networking.requireOutput("privateSubnetIds") as pulumi.Output<string[]>;
const publicSubnetIds = networking.requireOutput("publicSubnetIds") as pulumi.Output<string[]>;
const databaseSubnetIds = networking.requireOutput("databaseSubnetIds") as pulumi.Output<string[]>;
const intraSubnetIds = networking.requireOutput("intraSubnetIds") as pulumi.Output<string[]>;
const availabilityZones = networking.requireOutput("availabilityZones") as pulumi.Output<string[]>;
const dbSubnetGroupName = networking.requireOutput("dbSubnetGroupName") as pulumi.Output<string>;

const webUiStackName = "nucleus-cloud-ops-web-ui";

// ============================================================================
// S3 BUCKETS
// ============================================================================

// Single unified bucket — all features use namespaced prefixes:
//   agent-temp/tenants/{tenantId}/...     (1-day expiry)
//   kb-staging/tenants/{tenantId}/...     (1-day expiry)
//   inventory-raw/tenants/{tenantId}/...  (365-day expiry)
//   inventory-exports/tenants/{tenantId}/... (7-day expiry)
//   assets/tenants/{tenantId}/...         (no expiry)
const appBucket = new aws.s3.BucketV2("app-bucket", {
    bucket: pulumi.interpolate`${appName}-${accountId}-${region}`,
    forceDestroy: false,
}, { retainOnDelete: true });

new aws.s3.BucketLifecycleConfigurationV2("app-bucket-lifecycle", {
    bucket: appBucket.id,
    rules: [
        {
            id: "agent-temp-expire-1d",
            status: "Enabled",
            filter: { prefix: "agent-temp/" },
            expiration: { days: 1 },
        },
        {
            id: "kb-staging-expire-1d",
            status: "Enabled",
            filter: { prefix: "kb-staging/" },
            expiration: { days: 1 },
        },
        {
            id: "inventory-raw-expire-365d",
            status: "Enabled",
            filter: { prefix: "inventory-raw/" },
            expiration: { days: 365 },
        },
        {
            id: "inventory-exports-expire-7d",
            status: "Enabled",
            filter: { prefix: "inventory-exports/" },
            expiration: { days: 7 },
        },
    ],
});


// ============================================================================
// COGNITO AUTHENTICATION
// ============================================================================

// UserPool — self-signup enabled, email sign-in, case-insensitive
const userPool = new aws.cognito.UserPool("web-ui-user-pool", {
    name: `${appName}-web-ui-user-pool`,
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
    domain: pulumi.interpolate`${appName}-web-ui-auth-${accountId}`,
});

// UserPoolClient — OAuth code grant, secret required for NextAuth
const userPoolClient = new aws.cognito.UserPoolClient("web-ui-user-pool-client", {
    name: `${appName}-web-ui-app-client`,
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
        "http://localhost:3001/api/auth/callback/cognito",
        `${appUrl}/api/auth/callback/cognito`,
    ],
    logoutUrls: ["http://localhost:3000", "http://localhost:3001", appUrl],
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
    identityPoolName: `${appName}-web-ui-identity-pool`,
    allowUnauthenticatedIdentities: false,
    cognitoIdentityProviders: [{
        clientId: userPoolClient.id,
        providerName: userPool.endpoint,
    }],
});

// AuthenticatedRole — Cognito federated principal
const authenticatedRole = new aws.iam.Role("web-ui-authenticated-role", {
    name: `${appName}-web-ui-authenticated-role`,
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


// Wire authenticated role to identity pool
new aws.cognito.IdentityPoolRoleAttachment("web-ui-identity-pool-role-attachment", {
    identityPoolId: identityPool.id,
    roles: { authenticated: authenticatedRole.arn },
});

// ============================================================================
// SNS TOPIC
// ============================================================================

const snsTopic = new aws.sns.Topic("scheduler-sns-topic", {
    name: `${appName}-sns-topic`,
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
    name: `${appName}-rds-sg${nameSuffix}`,
    // description is immutable on aws.ec2.SecurityGroup — kept in sync with
    // securityGroupDescriptionSuffix so it byte-matches whatever is already live.
    description: `Security group for RDS PostgreSQL - VPC internal access${securityGroupDescriptionSuffix}`,
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
    identifier: `${appName}-postgres`,
    engine: "postgres",
    engineVersion: engineVersion,
    instanceClass: "db.t4g.micro",
    dbName: dbName,
    username: dbUsername,
    password: dbPassword,
    // dbSubnetGroupName has a history of being treated as ForceNew by this
    // provider family — moving an instance to a different subnet group must
    // go through a raw `aws rds modify-db-instance` call outside Pulumi
    // (followed by a `pulumi refresh`), never a direct code edit here while
    // the live value still differs from what's declared.
    dbSubnetGroupName: dbSubnetGroupName,
    vpcSecurityGroupIds: [rdsSecurityGroup.id],
    multiAz: false,
    allocatedStorage: 20,
    storageType: "gp3",
    skipFinalSnapshot: false,
    finalSnapshotIdentifier: `${appName}-postgres-final`,
    deletionProtection: true,
    // Was 0 (no automated backups, no point-in-time recovery at all) on both
    // stacks — the only recovery path was a manual snapshot someone
    // remembered to take. In-place ModifyDBInstance, no reboot.
    backupRetentionPeriod: 7,
    tags: { Name: `${appName}-postgres` },
}, { retainOnDelete: false, protect: true });

// Store full connection string in Secrets Manager (needs postgresInstance.address)
new aws.secretsmanager.SecretVersion("database-url-version", {
    secretId: databaseUrlSm.id,
    secretString: pulumi.interpolate`postgresql://${dbUsername}:${dbPasswordRandom.result}@${postgresInstance.address}:5432/${dbName}?sslmode=require&uselibpqcompat=true`,
});



// ============================================================================
// BASTION HOST (SSM Session Manager — no SSH, private subnet only)
// ============================================================================

// IAM role — SSM managed instance core only, no SSH key needed
const bastionRole = new aws.iam.Role("bastion-role", {
    name: `${appName}-bastion-role`,
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
    tags: { Name: `${appName}-bastion-role` },
});

new aws.iam.RolePolicyAttachment("bastion-ssm-policy", {
    role: bastionRole.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
});

const bastionInstanceProfile = new aws.iam.InstanceProfile("bastion-instance-profile", {
    name: `${appName}-bastion-profile`,
    role: bastionRole.name,
});

// Latest Amazon Linux 2023 ARM64 AMI (full, not minimal — SSM agent pre-installed)
// Filter: standard AMIs start with the date (20...), minimal AMIs start with "minimal-"
const bastionAmi = aws.ec2.getAmiOutput({
    mostRecent: true,
    owners: ["amazon"],
    filters: [
        { name: "name", values: ["al2023-ami-20*-*-arm64"] },
        { name: "architecture", values: ["arm64"] },
        { name: "virtualization-type", values: ["hvm"] },
    ],
});

// User data to ensure SSM agent is installed and running (safety net for minimal AMIs)
const bastionUserData = pulumi.all([bastionAmi.name]).apply(([amiName]) => {
    const script = `#!/bin/bash
# Install SSM agent if not present (minimal AMIs don't include it)
if ! rpm -q amazon-ssm-agent &>/dev/null; then
    dnf install -y amazon-ssm-agent
    systemctl enable amazon-ssm-agent
    systemctl start amazon-ssm-agent
else
    systemctl enable amazon-ssm-agent
    systemctl start amazon-ssm-agent
fi
`;
    return Buffer.from(script).toString("base64");
});

// No inbound rules — SSM agent initiates outbound connections to SSM endpoints
const bastionSg = new aws.ec2.SecurityGroup("bastion-sg", {
    name: `${appName}-bastion-sg${nameSuffix}`,
    // description is immutable on aws.ec2.SecurityGroup — see the rds-sg note above.
    description: `Bastion - SSM only, no inbound SSH${securityGroupDescriptionSuffix}`,
    vpcId: vpcId,
    egress: [
        {
            fromPort: 443,
            toPort: 443,
            protocol: "tcp",
            cidrBlocks: ["0.0.0.0/0"],
            description: "HTTPS to SSM endpoints (via NAT or VPC endpoints)",
        },
        {
            fromPort: 5432,
            toPort: 5432,
            protocol: "tcp",
            cidrBlocks: [vpcCidr],
            description: "PostgreSQL tunnel to RDS",
        },
    ],
    tags: { Name: `${appName}-bastion-sg${nameSuffix}` },
});

// t4g.small in first private subnet — no public IP, reachable only via SSM
const bastionInstance = new aws.ec2.Instance("bastion", {
    ami: bastionAmi.id,
    instanceType: "t4g.small",
    subnetId: privateSubnetIds.apply(ids => ids[0]),
    iamInstanceProfile: bastionInstanceProfile.name,
    vpcSecurityGroupIds: [bastionSg.id],
    userData: bastionUserData,
    associatePublicIpAddress: false,
    tags: { Name: `${appName}-bastion${nameSuffix}` },
});

export const bastionInstanceId = bastionInstance.id;

// ============================================================================
// ECS + ALB + CLOUDFRONT
// ============================================================================

// ECR Repository — WebUI container images
const ecrRepository = new aws.ecr.Repository("web-ui-ecr-repo", {
    name: `${appName}-web-ui`,
    imageTagMutability: "MUTABLE",
    forceDelete: false,
});

// ECR Lifecycle Policy — intentionally omitted; all images are retained indefinitely

// ECR public login — authenticate Docker to public.ecr.aws before building
// images so base image pulls (e.g. public.ecr.aws/docker/library/node) succeed.
const ecrPublicLogin = new command.local.Command("ecr-public-login", {
    create: "aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws",
    environment: {
        BUILDX_NO_DEFAULT_ATTESTATIONS: "1",
    },
});

// Explicit source hash — combines apps/web-ui/ + libs/prisma/ + libs/rbac/ + patches/ so any
// change to any produces a new imageTag, forcing a Docker rebuild + new ECS task definition
// revision. patches/ is COPYed into the image and applied by bun install, so a patch edit must
// rebuild. libs/rbac/ holds the committed route-manifest.json that middleware.ts's Layer 1
// route guard reads at request time (apps/web-ui/lib/rbac/route-authz.ts) — without it here, a
// rbac:sync regeneration (fixing an unmapped-route 403) would silently not redeploy.
const webUiSrcHash = crypto.createHash("sha256")
    .update(hashDirectory(path.join(repoRoot, "apps/web-ui")))
    .update(hashDirectory(path.join(repoRoot, "libs", "prisma")))
    .update(hashDirectory(path.join(repoRoot, "libs", "rbac")))
    .update(hashDirectory(path.join(repoRoot, "patches")))
    .digest("hex")
    .substring(0, 12);

const webUiImage = new awsx.ecr.Image("web-ui-image", {
    repositoryUrl: ecrRepository.repositoryUrl,
    context: repoRoot,
    dockerfile: path.join(repoRoot, "apps/web-ui/Dockerfile"),
    platform: "linux/arm64",
    imageTag: webUiSrcHash,
    args: {
        BUILDX_NO_DEFAULT_ATTESTATIONS: "1",
    },
    cacheFrom: [pulumi.interpolate`${ecrRepository.repositoryUrl}:latest`],
}, { dependsOn: [ecrPublicLogin], retainOnDelete: true });

// ECS Cluster
const ecsCluster = new aws.ecs.Cluster("web-ui-ecs-cluster", {
    name: `${appName}-ecs-cluster`,
    settings: [{ name: "containerInsights", value: "enabled" }],
});

// WebUI CloudWatch Log Group
const webUiLogGroup = new aws.cloudwatch.LogGroup("web-ui-log-group", {
    name: `/ecs/${appName}-web-ui-service`,
    retentionInDays: 7,
});

// ECS Task Execution Role — ECR pull + CloudWatch logs
const ecsTaskExecutionRole = new aws.iam.Role("ecs-task-execution-role", {
    name: `${appName}-ecs-execution-role`,
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

new aws.iam.RolePolicy("ecs-execution-role-secrets-policy", {
    role: ecsTaskExecutionRole.id,
    policy: pulumi.all([nextauthSecretSm.arn, databaseUrlSm.arn, internalApiKeySm.arn]).apply(
        ([nextauthArn, dbArn, internalKeyArn]) =>
            JSON.stringify({
                Version: "2012-10-17",
                Statement: [{
                    Effect: "Allow",
                    Action: ["secretsmanager:GetSecretValue"],
                    Resource: [nextauthArn, dbArn, internalKeyArn],
                }],
            })
    ),
});

// ECS Task Role — application permissions
const ecsTaskRole = new aws.iam.Role("ecs-task-role", {
    name: `${appName}-ecs-task-role`,
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
});


// 5b. S3 — read/write on unified app bucket
new aws.iam.RolePolicy("ecs-task-s3-policy", {
    role: ecsTaskRole.id,
    policy: appBucket.arn.apply(arn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
                    "s3:ListBucket", "s3:GetBucketLocation",
                ],
                Resource: [arn, `${arn}/*`],
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

// 5h. Cognito IDP — user management (invitations, admin ops)
new aws.iam.RolePolicy("ecs-task-cognito-idp-policy", {
    role: ecsTaskRole.id,
    policy: userPool.arn.apply(poolArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "cognito-idp:AdminCreateUser",
                    "cognito-idp:AdminDeleteUser",
                    "cognito-idp:AdminGetUser",
                    "cognito-idp:AdminUpdateUserAttributes",
                    "cognito-idp:AdminSetUserPassword",
                    "cognito-idp:AdminAddUserToGroup",
                    "cognito-idp:AdminRemoveUserFromGroup",
                    "cognito-idp:ListUsers",
                    "cognito-idp:ListGroups",
                ],
                Resource: [poolArn],
            }],
        })
    ),
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

// WebUI Task Definition — ARM64, FARGATE, 2048 CPU / 4096 MiB
// retainOnDelete: true — Pulumi must NOT deactivate old task definition revisions on replace.
// ECS task definitions are immutable revisions; deleting the Pulumi resource deactivates the
// revision in AWS, which breaks rollback. Retain ensures all historical revisions stay ACTIVE.
const webUiTaskDef = new aws.ecs.TaskDefinition("web-ui-task-def", {
    family: `${appName}-web-ui-task`,
    cpu: "2048",
    memory: "4096",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: ecsTaskExecutionRole.arn,
    taskRoleArn: ecsTaskRole.arn,
    runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
    },
    containerDefinitions: pulumi.all([
        userPool.id,
        userPoolClient.id,
        userPoolClient.clientSecret,
        appBucket.bucket,
        webUiLogGroup.name,
        accountId,
        webUiImage.imageUri,
        nextauthSecretSm.arn,
        databaseUrlSm.arn,
        internalApiKeySm.arn,
    ]).apply(([
        cognitoPoolId, cognitoClientId, cognitoClientSecret,
        appBucketN,
        webUiLogGroupN, acctId, imageUri,
        nextauthSecretArn, databaseUrlArn, internalApiKeyArn,
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
        secrets: [
            { name: "NEXTAUTH_SECRET", valueFrom: nextauthSecretArn },
            { name: "DATABASE_URL", valueFrom: databaseUrlArn },
            { name: "INTERNAL_API_KEY", valueFrom: internalApiKeyArn },
        ],
        environment: [
            { name: "NODE_ENV", value: "production" },
            { name: "PORT", value: "3000" },
            { name: "AWS_REGION", value: region },
            { name: "NEXT_PUBLIC_AWS_REGION", value: region },
            { name: "HUB_ACCOUNT_ID", value: acctId },
            { name: "NEXT_PUBLIC_HUB_ACCOUNT_ID", value: acctId },
            { name: "COGNITO_USER_POOL_ID", value: cognitoPoolId },
            { name: "COGNITO_APP_CLIENT_ID", value: cognitoClientId },
            { name: "COGNITO_APP_CLIENT_SECRET", value: cognitoClientSecret },
            { name: "COGNITO_ISSUER", value: `https://cognito-idp.${region}.amazonaws.com/${cognitoPoolId}` },
            { name: "NEXTAUTH_URL", value: appUrl },
            { name: "APP_BUCKET_NAME", value: appBucketN },
            { name: "DATA_DIR", value: "/tmp" },
            { name: "BEDROCK_MODEL_ID", value: "amazon.titan-embed-text-v2:0" },
            { name: "ASK_AI_GENERATION_MODEL", value: "global.anthropic.claude-sonnet-4-6" },
            { name: "LANGFUSE_ENABLED", value: "false" },
            { name: "LANGFUSE_HOST", value: "https://cloud.langfuse.com" },
            { name: "USE_PG_SCHEDULES", value: "true" },
            // ChatBotPersona + Triage — gateway-layer routing
            { name: "CHATBOT_PERSONA_ENABLED", value: "true" },
            { name: "CHATBOT_PERSONA_CHANNELS", value: "telegram" },
            { name: "CHAT_TRIAGE_ENABLED", value: "true" },
            // Run narration checklist. Strict allowlist — omitting this disables
            // narration everywhere, so it is set explicitly.
            { name: "NARRATION_CHANNELS", value: "telegram" },
            // Fargate Spot Guard — the hub bus ARN baked into each customer's onboarding
            // template as the HubEventBusArn parameter default and the forwarding rule's
            // target. Without it the template route falls back to a `not-configured`
            // placeholder AND forces EnableSpotAutomation to "false" (see
            // spotGuardOptions in app/api/accounts/template/route.ts) — so the account
            // toggle silently could not be turned on. Omitted entirely when the stack has
            // not opted in, which keeps that fail-closed behaviour for those stacks.
            ...(spotGuardEnabled
                ? [{
                    name: "SPOT_GUARD_BUS_ARN",
                    value: `arn:aws:events:${region}:${acctId}:event-bus/${spotGuardBusNameLiteral}`,
                }]
                : []),
            // RBAC/ABAC rollout. The DEFAULTS here stay false/shadow, so a stack
            // that does not opt in is unchanged. sbx opts into both; prod has
            // taken DYNAMIC_ABAC_ENABLED only, with the route guard still to
            // follow as its own deploy.
            //
            // Declaring them here is what made the cutover a value change plus a
            // deploy rather than a code change: shadow logging
            // (rbac.parity.mismatch, rbac.row_filter.shadow) flowed from
            // production first, and authorize.ts gates the flip on that mismatch
            // counter reaching zero across a soak that exercises every role in
            // active use.
            //
            // Enforcing does NOT create grants — it only changes which store the
            // decision reads. A role whose `rbac_role_rules` are thinner than its
            // legacy `custom_roles.permissions` blob loses access at the moment
            // this turns on, so the blob->rules projection must be verified per
            // environment first (apps/web-ui/scripts/backfill-rbac.ts --dry-run).
            { name: "DYNAMIC_ABAC_ENABLED", value: String(dynamicAbacEnabled) },
            { name: "RBAC_ROUTE_GUARD_MODE", value: rbacRouteGuardMode },
            // Step 5 of the rollout (docs/superpowers/specs/2026-08-12-submodule-rbac-design.md
            // §8) — ships as its own deploy, gated on a quiet rbac.page_guard.shadow_denial
            // log from step 3, observed after step 4 (DYNAMIC_ABAC_ENABLED) has settled.
            { name: "RBAC_PAGE_GUARD_MODE", value: rbacPageGuardMode },
        ],
    }])),
}, { retainOnDelete: true });

// ============================================================================
// ALB + SECURITY GROUPS + TARGET GROUP + LISTENER
// ============================================================================

// Look up CloudFront managed prefix list (restricts ALB inbound to CloudFront only)
const cloudFrontPrefixList = aws.ec2.getManagedPrefixListOutput({
    name: "com.amazonaws.global.cloudfront.origin-facing",
});

// ALB Security Group — inbound port 80 from CloudFront managed prefix list only
const albSecurityGroup = new aws.ec2.SecurityGroup("alb-sg", {
    name: `${appName}-alb-sg${nameSuffix}`,
    // description is immutable on aws.ec2.SecurityGroup — see the rds-sg note above.
    description: `Security group for WebUI ALB - CloudFront origin only${securityGroupDescriptionSuffix}`,
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
    name: `${appName}-ecs-service-sg${nameSuffix}`,
    // description is immutable on aws.ec2.SecurityGroup — see the rds-sg note above.
    description: `Security group for WebUI ECS tasks - ALB traffic only${securityGroupDescriptionSuffix}`,
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
    name: `${appName}-alb${nameSuffix}`,
    internal: false,
    loadBalancerType: "application",
    securityGroups: [albSecurityGroup.id],
    subnets: publicSubnetIds,
    idleTimeout: 1200,
});

// Target Group — IP target type, port 3000, /api/health health check
const webUiTargetGroup = new aws.lb.TargetGroup("web-ui-tg", {
    name: `${appName}-web-ui-tg${nameSuffix}`,
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

// ECS Fargate Service — forceNewDeployment, circuit breaker with rollback
const webUiService = new aws.ecs.Service("web-ui-service", {
    name: `${appName}-web-ui-service${nameSuffix}`,
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
    // 15 min grace period so a replacement task has time to finish
    // `prisma migrate deploy` + Next.js boot before ECS decides it's
    // unhealthy and recycles it again.
    healthCheckGracePeriodSeconds: 900,
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
}, {
    dependsOn: [httpListener],
    // desiredCount:1 above is a fixed literal, but the autoscaling target
    // below has minCapacity:2 — live reality is always >=2, so without this
    // every unrelated `pulumi up` diffs 2->1 and (because
    // forceNewDeployment:true) force-rolls the service.
    ignoreChanges: ["desiredCount"],
});

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
    name: `${appName}-web-ui-cpu-scaling${nameSuffix}`,
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
    name: `${appName}-web-ui-memory-scaling${nameSuffix}`,
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

// S3 bucket exports
export const appBucketName = appBucket.bucket;
export const appBucketArn = appBucket.arn;

// Cognito exports
export const cognitoUserPoolId = userPool.id;
export const cognitoUserPoolArn = userPool.arn;
export const cognitoUserPoolClientId = userPoolClient.id;
export const cognitoUserPoolClientSecret = pulumi.secret(userPoolClient.clientSecret);
export const cognitoIdentityPoolId = identityPool.id;
export const cognitoDomainPrefix = pulumi.interpolate`${appName}-web-ui-auth-${accountId}`;

// SNS exports
export const snsTopicArn = snsTopic.arn;

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

// RDS PostgreSQL exports
export const postgresEndpoint = postgresInstance.address;


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
    name: `${appName}-workers`,
    imageTagMutability: "MUTABLE",
    forceDelete: false,
});

// ECR Lifecycle Policy — intentionally omitted; all images are retained indefinitely

// Explicit source hash — combines apps/workers/ + libs/prisma/ so any change forces a rebuild.
const workersSrcHash = crypto.createHash("sha256")
    .update(hashDirectory(path.join(repoRoot, "apps/workers")))
    .update(hashDirectory(path.join(repoRoot, "libs", "prisma")))
    .digest("hex")
    .substring(0, 12);

// Workers Docker image — auto-built and pushed to ECR on source change
const workersImage = new awsx.ecr.Image("workers-image", {
    repositoryUrl: workersEcrRepo.repositoryUrl,
    context: repoRoot,
    dockerfile: path.join(repoRoot, "apps/workers/Dockerfile"),
    platform: "linux/arm64",
    imageTag: workersSrcHash,
    args: {
        BUILDX_NO_DEFAULT_ATTESTATIONS: "1",
    },
    cacheFrom: [pulumi.interpolate`${workersEcrRepo.repositoryUrl}:latest`],
}, { dependsOn: [ecrPublicLogin], retainOnDelete: true });

const workersLogGroup = new aws.cloudwatch.LogGroup("workers-log-group", {
    name: `/ecs/${appName}-workers`,
    retentionInDays: 7,
});

const workersTaskRole = new aws.iam.Role("workers-task-role", {
    name: `${appName}-workers-task-role`,
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
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

// CloudWatch custom metrics (best-effort dead-letter / queue-depth metrics from
// observability.ts). PutMetricData cannot be resource-scoped; namespace is
// constrained via a condition so this cannot publish outside Nucleus/Workers.
new aws.iam.RolePolicy("workers-cloudwatch-metrics-policy", {
    role: workersTaskRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: ["cloudwatch:PutMetricData"],
            Resource: ["*"],
            Condition: { StringEquals: { "cloudwatch:namespace": "Nucleus/Workers" } },
        }],
    }),
});

new aws.iam.RolePolicy("workers-s3-policy", {
    role: workersTaskRole.id,
    policy: appBucket.arn.apply(arn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
                    Resource: [arn, `${arn}/*`],
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
    name: `/ecs/${appName}-ephemeral-workers`,
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
                Resource: [`${dbArn.replace(':rds:', ':rds-db:').replace(':db:', ':dbuser:')}/${dbUsername}`],
            }],
        })
    ),
});

// Ephemeral worker task definition — lightweight tasks for horizontal dispatch
const EPHEMERAL_WORKER_TASK_FAMILY = `${appName}-ephemeral-worker-task`;
const ephemeralWorkerTaskDef = new aws.ecs.TaskDefinition("ephemeral-worker-task-def", {
    family: EPHEMERAL_WORKER_TASK_FAMILY,
    cpu: "2048",
    memory: "4096",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: ecsTaskExecutionRole.arn,
    taskRoleArn: workersTaskRole.arn,
    runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
    },
    containerDefinitions: pulumi.all([
        appBucket.bucket,
        ephemeralWorkersLogGroup.name,
        snsTopic.arn,
        workersImage.imageUri,
        databaseUrlSm.arn,
        internalApiKeySm.arn,
        cloudFrontDistribution.domainName,
    ]).apply(([
        appBucketN,
        ephLogGroupN, snsTopicArn, imageUri, databaseUrlArn, internalApiKeyArn, cloudFrontDomain,
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
        secrets: [
            { name: "DATABASE_URL", valueFrom: databaseUrlArn },
            // Ephemeral tasks run job-runner, which for agent-ops-tick makes the
            // authenticated internal call back to the web-ui — needs the shared key.
            { name: "INTERNAL_API_KEY", valueFrom: internalApiKeyArn },
        ],
        environment: [
            { name: "AWS_REGION", value: region },
            { name: "APP_BUCKET_NAME", value: appBucketN },
            { name: "BEDROCK_MODEL_ID", value: "amazon.titan-embed-text-v2:0" },
            { name: "USE_PG_SCHEDULES", value: "true" },
            { name: "LOG_LEVEL", value: "info" },
            { name: "WEB_UI_BASE_URL", value: `https://${cloudFrontDomain}` },
        ],
    }])),
}, { retainOnDelete: true });

// IAM policy for workers to dispatch ECS tasks (horizontal executor)
new aws.iam.RolePolicy("workers-ecs-dispatch-policy", {
    role: workersTaskRole.id,
    policy: pulumi.all([ecsCluster.arn, ecsCluster.name, workersTaskRole.arn, ecsTaskExecutionRole.arn, accountId]).apply(
        ([clusterArn, clusterName, taskRoleArn, execRoleArn, accId]) =>
            JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: "Allow",
                        Action: ["ecs:RunTask"],
                        // Family wildcard, NOT the exact task-def ARN (which is pinned to one
                        // revision). Every workers deploy bumps the ephemeral task-def revision;
                        // pinning here creates a rollout race where the still-running old workers
                        // container (holding the previous revision's ARN in HORIZONTAL_TASK_DEF_ARN)
                        // gets AccessDenied against the just-updated policy until ECS finishes
                        // replacing it — which crash-loops the service in the meantime.
                        Resource: [`arn:aws:ecs:${region}:${accId}:task-definition/${EPHEMERAL_WORKER_TASK_FAMILY}:*`],
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
                        Action: ["ecs:ListTasks"],
                        // ListTasks authorizes against the CONTAINER-INSTANCE ARN, not the task
                        // or cluster ARN — an AWS quirk that holds even on Fargate, where no
                        // container instances exist. The denial named it exactly:
                        //   not authorized to perform: ecs:ListTasks on resource:
                        //   arn:aws:ecs:…:container-instance/<cluster>/*
                        // so this ARN is what IAM evaluates, and embedding the cluster name in
                        // it keeps the grant scoped to this cluster.
                        //
                        // Deliberately NOT written as Resource "*" + ArnEquals ecs:cluster like
                        // DescribeTasks above: the IAM simulator returns implicitDeny for that
                        // shape with MissingContextValues=[ecs:cluster], so it only works if the
                        // caller populates that key. A resource-scoped grant needs no such
                        // assumption and is equally narrow.
                        Resource: [`arn:aws:ecs:${region}:${accId}:container-instance/${clusterName}/*`],
                    },
                    {
                        Effect: "Allow",
                        Action: ["ecs:StopTask"],
                        // The executor stops a LEAKED task: one whose job timed out or whose
                        // adopt-by-startedBy found a duplicate. Without this grant that path failed
                        // silently — executor/horizontal.ts logs "Failed to stop leaked ECS task —
                        // may run to completion on its own" and moves on, so an orphaned Fargate
                        // task kept billing until it exited by itself.
                        //
                        // Scoped to tasks in THIS cluster: StopTask authorizes against the task ARN
                        // (unlike ListTasks, which uses container-instance), and the cluster name is
                        // embedded in it. Not written as Resource "*" + ArnEquals ecs:cluster for
                        // the same reason as ListTasks above — the simulator returns implicitDeny
                        // for that shape with MissingContextValues=[ecs:cluster].
                        //
                        // Note this covers only the hub's own ephemeral workers. Stopping tasks in a
                        // customer account goes through the assumed spoke role, not this one.
                        Resource: [`arn:aws:ecs:${region}:${accId}:task/${clusterName}/*`],
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

// ============================================================================
// FARGATE SPOT GUARD — CROSS-ACCOUNT ECS EVENT INGESTION  (sbx only for now)
// ============================================================================
// The first EventBridge and SQS resources in this repo. Customer (spoke) accounts
// run a forwarding rule — see apps/web-ui/lib/cf-template-generator.ts, gated by
// its own EnableSpotAutomation parameter — that PutEvents ECS Spot events onto the
// DEDICATED bus below. Never the hub's `default` bus: untrusted customer traffic
// must not be able to reach a rule we did not write for it.
//
// Gated on spotGuardEnabled (false unless the stack opts in), so prod synthesises
// byte-identically to today until someone adds the config key.
//
// ⚠️  THE BUS RESOURCE POLICY IS INTENTIONALLY NOT DECLARED HERE.
// The set of permitted spoke accounts changes at RUNTIME (account onboarding,
// removal, toggling Account.spotAutomationEnabled). A Pulumi-managed
// aws.cloudwatch.EventBusPolicy would revert every runtime change on the next
// `pulumi up`, silently cutting off every customer added since the last deploy.
// The policy is owned end-to-end by the workers reconciler
// (apps/workers/src/jobs/spot-guard/bus-policy.ts) via events:PutPermission, which
// rebuilds the whole document from Postgres. A fresh custom bus has NO policy, so
// the fail-closed default is "hub account only" until that reconciler first runs.
// Do NOT add aws.cloudwatch.EventBusPolicy or aws.cloudwatch.EventPermission here.
let spotGuardBus: aws.cloudwatch.EventBus | undefined;
let spotGuardQueue: aws.sqs.Queue | undefined;
let spotGuardDlq: aws.sqs.Queue | undefined;
let spotGuardRule: aws.cloudwatch.EventRule | undefined;

if (spotGuardEnabled) {
    spotGuardBus = new aws.cloudwatch.EventBus("spot-guard-bus", {
        name: spotGuardBusNameLiteral,
        description: "Nucleus Fargate Spot Guard — cross-account ECS Spot events from onboarded customer accounts",
    });

    // DLQ first — the main queue references it by ARN in redrivePolicy.
    // 14-day retention (the SQS maximum) so a poison event is still inspectable.
    spotGuardDlq = new aws.sqs.Queue("spot-guard-dlq", {
        name: `${appName}-spot-guard-dlq`,
        messageRetentionSeconds: 1209600,
        visibilityTimeoutSeconds: 60,
        sqsManagedSseEnabled: true,
    });

    // Main ingest queue.
    //   visibilityTimeoutSeconds 60 — the consumer only parses JSON and does one
    //     boss.send (sub-second). 60s is a generous ceiling that doubles as the
    //     redelivery delay when an enqueue fails and we deliberately do NOT delete.
    //   messageRetentionSeconds 14400 (4h) — a Spot interruption is only actionable
    //     for ~2 minutes, so retaining for days would mean replaying long-dead
    //     interruptions after an outage. 4h still lets task START/STOP accounting
    //     recover without resurrecting stale remediation work.
    //   sqsManagedSseEnabled — SSE-SQS rather than a CMK, which would additionally
    //     need kms:GenerateDataKey for the EventBridge service principal in the key
    //     policy. Not worth the extra moving part for ECS event metadata.
    spotGuardQueue = new aws.sqs.Queue("spot-guard-queue", {
        name: `${appName}-spot-guard-events`,
        visibilityTimeoutSeconds: 60,
        messageRetentionSeconds: 14400,
        receiveWaitTimeSeconds: 20, // queue-level long-poll default
        sqsManagedSseEnabled: true,
        redrivePolicy: spotGuardDlq.arn.apply((dlqArn) =>
            JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 5 })
        ),
    });

    // Hub-side rule. Two jobs:
    //   1. Pin source to aws.ecs, dropping the reference implementation's
    //      "test.aws.ecs" alias — that alias let any sender inject synthetic events.
    //   2. Re-assert the shape the spoke rule forwards, so a spoke that ignores our
    //      template and PutEvents arbitrary payloads still cannot reach the queue.
    //
    // The two-branch $or is load-bearing and NOT a stylistic choice: a blanket
    // detail.capacityProviderName exists-filter would silently DROP every
    // placement-failure event, because those carry capacityProviderArns instead —
    // i.e. it would disable the single most important behaviour in the feature while
    // looking correct. The filter is still worth having on the task-state branch: it
    // excludes bare launchType:FARGATE services, which have no Spot to fall back
    // from, and that is where most of the event volume lives.
    //
    // lastStatus is narrowed to RUNNING/STOPPED because ECS emits 6-8 task-state
    // events per task lifecycle and the hours report needs exactly two. Roughly a
    // 70% volume cut on the dominant event type — and the SENDING account pays for
    // cross-account custom events, so this is a customer cost decision, not just ours.
    // The interruption path is unaffected: those arrive with desiredStatus STOPPED.
    //
    // The account allowlist is deliberately NOT in this pattern: eventPattern is
    // capped at 2048 chars and is Pulumi-managed, so it would drift on every
    // onboarding. Sender authorization lives in the bus policy; per-event
    // authorization lives in the consumer.
    spotGuardRule = new aws.cloudwatch.EventRule("spot-guard-rule", {
        name: `${appName}-spot-guard-ingest`,
        eventBusName: spotGuardBus.name,
        description: "Route forwarded customer ECS Spot events to the Spot Guard ingest queue",
        state: "ENABLED",
        eventPattern: JSON.stringify({
            source: ["aws.ecs"],
            $or: [
                {
                    "detail-type": ["ECS Task State Change"],
                    detail: {
                        capacityProviderName: [{ exists: true }],
                        lastStatus: ["RUNNING", "STOPPED"],
                    },
                },
                {
                    "detail-type": ["ECS Deployment State Change", "ECS Service Action"],
                    detail: {
                        eventName: ["SERVICE_TASK_PLACEMENT_FAILURE"],
                        capacityProviderArns: [{ exists: true }],
                    },
                },
            ],
        }),
    });

    // Queue policy scoped to THIS rule only. Note that a rule on a CUSTOM bus has
    // ARN .../rule/<bus-name>/<rule-name>, not .../rule/<rule-name> — using
    // spotGuardRule.arn avoids hand-building that wrong. aws:SourceAccount is
    // belt-and-braces against a same-service confused deputy from another account.
    const spotGuardQueuePolicy = new aws.sqs.QueuePolicy("spot-guard-queue-policy", {
        queueUrl: spotGuardQueue.id,
        policy: pulumi.all([spotGuardQueue.arn, spotGuardRule.arn, accountId]).apply(
            ([queueArn, ruleArn, acctId]) =>
                JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [{
                        Sid: "AllowSpotGuardRuleToSend",
                        Effect: "Allow",
                        Principal: { Service: "events.amazonaws.com" },
                        Action: "sqs:SendMessage",
                        Resource: queueArn,
                        Condition: {
                            ArnEquals: { "aws:SourceArn": ruleArn },
                            StringEquals: { "aws:SourceAccount": acctId },
                        },
                    }],
                })
        ),
    });

    // Same-account SQS target needs no roleArn. dependsOn the queue policy so the
    // target is never live before the queue will accept the rule's SendMessage.
    new aws.cloudwatch.EventTarget("spot-guard-target", {
        rule: spotGuardRule.name,
        eventBusName: spotGuardBus.name,
        targetId: "spot-guard-sqs",
        arn: spotGuardQueue.arn,
        deadLetterConfig: { arn: spotGuardDlq.arn },
        retryPolicy: { maximumRetryAttempts: 4, maximumEventAgeInSeconds: 600 },
    }, { dependsOn: [spotGuardQueuePolicy] });

    // Workers: consume the ingest queue. ChangeMessageVisibility is included so the
    // consumer can shorten visibility on a message it received but chose not to
    // process during shutdown, returning it to the surviving replica immediately
    // instead of after the full 60s.
    new aws.iam.RolePolicy("workers-spot-guard-sqs-policy", {
        role: workersTaskRole.id,
        policy: pulumi.all([spotGuardQueue.arn, spotGuardDlq.arn]).apply(([qArn, dlqArn]) =>
            JSON.stringify({
                Version: "2012-10-17",
                Statement: [{
                    Effect: "Allow",
                    Action: [
                        "sqs:ReceiveMessage",
                        "sqs:DeleteMessage",
                        "sqs:GetQueueAttributes",
                        "sqs:GetQueueUrl",
                        "sqs:ChangeMessageVisibility",
                    ],
                    Resource: [qArn, dlqArn],
                }],
            })
        ),
    });

    // Workers: own the bus resource policy (the onboarded-account allowlist).
    // PutPermission with a `Policy` document REPLACES the entire bus policy — that
    // invariant is why nothing else may write here.
    //
    // NOTE: events:PutResourcePolicy does NOT exist as an EventBridge IAM action.
    // The only bus-policy actions are PutPermission / RemovePermission /
    // DescribeEventBus / CreateEventBus / UpdateEventBus.
    new aws.iam.RolePolicy("workers-spot-guard-bus-policy", {
        role: workersTaskRole.id,
        policy: spotGuardBus.arn.apply((busArn) =>
            JSON.stringify({
                Version: "2012-10-17",
                Statement: [{
                    Effect: "Allow",
                    Action: [
                        "events:PutPermission",
                        "events:RemovePermission",
                        "events:DescribeEventBus",
                    ],
                    Resource: [busArn],
                }],
            })
        ),
    });
}

const workersSecurityGroup = new aws.ec2.SecurityGroup("workers-sg", {
    name: `${appName}-workers-sg${nameSuffix}`,
    // description is immutable on aws.ec2.SecurityGroup — see the rds-sg note above.
    description: `Security group for pg-boss workers - egress only${securityGroupDescriptionSuffix}`,
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
    family: `${appName}-workers-task`,
    cpu: "2048",
    memory: "4096",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: ecsTaskExecutionRole.arn,
    taskRoleArn: workersTaskRole.arn,
    runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
    },
    containerDefinitions: pulumi.all([
        appBucket.bucket,
        workersLogGroup.name,
        snsTopic.arn,
        workersImage.imageUri,
        ecsCluster.arn,
        ephemeralWorkerTaskDef.arn,
        workersSecurityGroup.id,
        privateSubnetIds.apply(ids => ids.join(",")),
        databaseUrlSm.arn,
        internalApiKeySm.arn,
        cloudFrontDistribution.domainName,
        // Spot Guard. Resolve to "" when the stack has not opted in, so the tuple
        // arity is constant and the destructuring below never shifts.
        spotGuardQueue?.url ?? pulumi.output(""),
        spotGuardBus?.name ?? pulumi.output(""),
    ]).apply(([
        appBucketN,
        workersLogGroupN, snsTopicArn, imageUri,
        clusterArn, ephTaskDefArn, workersSgId, subnetsJoined, databaseUrlArn, internalApiKeyArn, cloudFrontDomain,
        spotGuardQueueUrl, spotGuardBusName,
    ]) => JSON.stringify([{
        name: "WorkersContainer",
        image: imageUri,
        essential: true,
        // Give in-flight pg-boss handlers time to drain before SIGKILL. Must exceed
        // the boss.stop() graceful timeout (90s in index.ts).
        stopTimeout: 120,
        // Container health check: probes the liveness server (health.ts). Goes
        // unhealthy when the pg-boss supervisor loop stops emitting monitor-states,
        // so ECS replaces a wedged task instead of leaving all crons silently dead.
        healthCheck: {
            command: [
                "CMD-SHELL",
                "node -e \"require('http').get('http://127.0.0.1:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\"",
            ],
            interval: 30,
            timeout: 5,
            retries: 3,
            startPeriod: 60,
        },
        logConfiguration: {
            logDriver: "awslogs",
            options: {
                "awslogs-group": workersLogGroupN,
                "awslogs-region": region,
                "awslogs-stream-prefix": "workers",
            },
        },
        secrets: [
            { name: "DATABASE_URL", valueFrom: databaseUrlArn },
            { name: "INTERNAL_API_KEY", valueFrom: internalApiKeyArn },
        ],
        environment: [
            { name: "AWS_REGION", value: region },
            { name: "APP_BUCKET_NAME", value: appBucketN },
            { name: "BEDROCK_MODEL_ID", value: "amazon.titan-embed-text-v2:0" },
            { name: "USE_PG_SCHEDULES", value: "true" },
            { name: "LOG_LEVEL", value: "info" },
            { name: "HEALTH_PORT", value: "8080" },
            // Per-replica local heartbeat cadence for the container health check.
            // Drives liveness independently of pg-boss's singleton monitor-states
            // event, so every replica in an autoscaled fleet stays healthy — not
            // just the one holding the monitor lock. 30s = 4 ticks within the
            // 120s staleness budget (HEALTH_STALENESS_MS in index.ts). See
            // apps/workers/src/lib/health.ts.
            { name: "HEALTH_HEARTBEAT_INTERVAL_MS", value: "30000" },
            // The workers -> web-ui internal trigger reaches the app via the public
            // CloudFront URL (NAT egress). The ALB is internet-facing and its SG
            // only admits CloudFront's prefix list, so a private-subnet worker
            // cannot hit the ALB directly; CloudFront also injects the
            // X-Origin-Verify header the origin path expects.
            { name: "WEB_UI_BASE_URL", value: `https://${cloudFrontDomain}` },
            { name: "WORKER_ARCH", value: "horizontal" },
            { name: "HORIZONTAL_CLUSTER_ARN", value: clusterArn },
            { name: "HORIZONTAL_TASK_DEF_ARN", value: ephTaskDefArn },
            { name: "HORIZONTAL_SUBNETS", value: subnetsJoined },
            { name: "HORIZONTAL_SECURITY_GROUP", value: workersSgId },
            { name: "HORIZONTAL_TASK_TIMEOUT_MS", value: "900000" },
            // Fargate Spot Guard. Present ONLY on this long-lived workers task
            // definition and ONLY when the stack opted in — never on
            // ephemeralWorkerTaskDef, because an ephemeral job-runner task must not
            // poll SQS. (It also structurally cannot: HorizontalExecutor overrides the
            // container command to `node dist/job-runner.js`, which never imports the
            // consumer. Withholding the queue URL is a second, independent guard.)
            //
            // SPOT_GUARD_ENABLED gates the worker-side registration, so the job family
            // can be dark-deployed: the image ships everywhere, the behaviour only
            // turns on where the infra exists.
            ...(spotGuardEnabled
                ? [
                      { name: "SPOT_GUARD_ENABLED", value: "true" },
                      { name: "SPOT_GUARD_QUEUE_URL", value: spotGuardQueueUrl },
                      { name: "SPOT_GUARD_BUS_NAME", value: spotGuardBusName },
                      { name: "SPOT_GUARD_POLL_WAIT_SECONDS", value: "20" },
                      { name: "SPOT_GUARD_POLL_BATCH_SIZE", value: "10" },
                  ]
                : []),
            // SCALING_AUDIT_ENABLED gates the worker-side registration (same
            // dark-deploy pattern as SPOT_GUARD_ENABLED above): the image ships
            // everywhere, the daily poll only turns on where the stack opted in.
            ...(scalingAuditEnabled ? [{ name: "SCALING_AUDIT_ENABLED", value: "true" }] : []),
        ],
    }])),
}, { retainOnDelete: true });

const workersService = new aws.ecs.Service("workers-service", {
    name: `${appName}-workers-service`,
    cluster: ecsCluster.arn,
    taskDefinition: workersTaskDef.arn,
    // 2 replicas for HA / zero-downtime rollouts. Safe now that duplicate execution
    // is structurally prevented: atomic per-tenant claim (tryClaimTenantRun) +
    // per-tenant stately singletonKeys + idempotent ECS launch (startedBy). pg-boss
    // itself dedups cron fires across instances (singletonKey + singletonSeconds),
    // and work() uses SELECT ... FOR UPDATE SKIP LOCKED so a job runs on one replica.
    desiredCount: workersDesiredCount,
    launchType: "FARGATE",
    forceNewDeployment: true,
    // Roll one task at a time (keep >=1 serving) and let ECS roll back a bad deploy.
    deploymentMinimumHealthyPercent: 50,
    deploymentMaximumPercent: 200,
    deploymentCircuitBreaker: { enable: true, rollback: true },
    // Same reasoning as web-ui's grace period: workers' own container health
    // check (health.ts liveness server, 60s startPeriod already) is separate
    // from this — this covers a container that's healthy while the DB is
    // still temporarily unreachable (e.g. mid-maintenance).
    healthCheckGracePeriodSeconds: 900,
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

// Fargate Spot Guard exports — undefined on stacks that have not opted in.
//
// spotGuardBusArn is the load-bearing one: it is the target baked into each
// customer's onboarding CloudFormation template, and the value a support engineer
// needs when debugging why a spoke's events are not arriving. Read it with
//   pulumi stack output spotGuardBusArn --stack sbx
export const spotGuardEnabledOutput = spotGuardEnabled;
export const spotGuardBusName = spotGuardBus?.name;
export const spotGuardBusArn = spotGuardBus?.arn;
export const spotGuardQueueUrl = spotGuardQueue?.url;
export const spotGuardQueueArn = spotGuardQueue?.arn;
export const spotGuardDlqUrl = spotGuardDlq?.url;
export const spotGuardRuleArn = spotGuardRule?.arn;

// ============================================================================
// PHASE 11: S3 VECTORS + S3 TABLES — CloudFormation Stack Wrappers
// ============================================================================
// These resources use alpha CDK constructs with no native Pulumi equivalent.
// CFN templates extracted from `cdk synth` output and wrapped in Pulumi.

// s3-vectors-stack disabled — will be removed in future milestone
// const s3VectorsTemplate = fs.readFileSync(path.join(__dirname, "s3-vectors-template.json"), "utf-8");
// const s3VectorsCfnStack = new aws.cloudformation.Stack("s3-vectors-stack", { ... });

// export const s3VectorsCfnStackId = s3VectorsCfnStack.id; // disabled
// s3-tables-stack removed — not needed in lean setup

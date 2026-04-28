#!/usr/bin/env npx tsx
/**
 * generate-env.ts
 *
 * Reads Pulumi compute stack outputs and writes web-ui/.env.local with all
 * required environment variables for local development.
 *
 * Usage:
 *   npx tsx scripts/generate-env.ts
 *
 * Prerequisites:
 *   - Pulumi CLI installed and authenticated
 *   - AWS credentials configured (AWS_PROFILE=PLATFORM-ADMIN)
 *   - infra/compute/ stack deployed (prod stack)
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..");
const COMPUTE_DIR = path.join(REPO_ROOT, "infra", "compute");
const ENV_OUTPUT_PATH = path.join(REPO_ROOT, "web-ui", ".env.local");
const PULUMI_STACK = "prod";

// ---------------------------------------------------------------------------
// Step 1: Run pulumi stack output --json --show-secrets
// ---------------------------------------------------------------------------

function fetchStackOutputs(): Record<string, string> {
    console.log(`Fetching Pulumi stack outputs from ${COMPUTE_DIR} (stack: ${PULUMI_STACK})...`);

    // Verify pulumi CLI is available
    try {
        execSync("pulumi version", { stdio: "pipe" });
    } catch {
        console.error(
            "ERROR: pulumi CLI not found.\n" +
            "Install it from https://www.pulumi.com/docs/install/ and re-run."
        );
        process.exit(1);
    }

    let raw: string;
    try {
        raw = execSync(
            `pulumi stack output --json --show-secrets --stack ${PULUMI_STACK}`,
            { cwd: COMPUTE_DIR, stdio: "pipe" }
        ).toString();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`ERROR: Failed to fetch Pulumi stack outputs:\n${msg}`);
        process.exit(1);
    }

    if (!raw || raw.trim() === "" || raw.trim() === "{}") {
        console.error("ERROR: Pulumi stack output returned empty JSON. Is the stack deployed?");
        process.exit(1);
    }

    return JSON.parse(raw) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Step 2: Map stack output keys → env var names
// ---------------------------------------------------------------------------

function mapOutputsToEnvVars(outputs: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};

    function set(key: string, value: string | undefined, required = false): void {
        if (value === undefined || value === null || value === "") {
            if (required) {
                console.warn(`WARN: Expected stack output key "${key}" is missing or empty.`);
            }
            return;
        }
        env[key] = value;
    }

    const o = outputs;

    // DynamoDB tables
    set("APP_TABLE_NAME", o.appTableName, true);
    set("NEXT_PUBLIC_APP_TABLE_NAME", o.appTableName, true);
    set("AUDIT_TABLE_NAME", o.auditTableName, true);
    set("NEXT_PUBLIC_AUDIT_TABLE_NAME", o.auditTableName, true);
    set("DYNAMODB_CHECKPOINT_TABLE", o.checkpointTableName);
    set("DYNAMODB_WRITES_TABLE", o.writesTableName);
    set("DYNAMODB_CHAT_HISTORY_TABLE", o.chatHistoryTableName);
    set("DYNAMODB_MEMORY_TABLE", o.memoryTableName);
    set("DYNAMODB_USERS_TEAMS_TABLE", o.usersTeamsTableName);
    set("AGENT_OPS_TABLE_NAME", o.agentOpsTableName);
    set("INVENTORY_TABLE_NAME", o.inventoryTableName);

    // S3 buckets
    set("APP_BUCKET_NAME", o.appBucketName);

    // SQS queues
    set("KB_SYNC_QUEUE_URL", o.kbSyncQueueUrl);
    set("VECTOR_PROCESSING_QUEUE_URL", o.vectorProcessingQueueUrl);

    // Cognito
    set("COGNITO_USER_POOL_ID", o.cognitoUserPoolId, true);
    set("NEXT_PUBLIC_COGNITO_USER_POOL_ID", o.cognitoUserPoolId, true);
    set("COGNITO_USER_POOL_CLIENT_ID", o.cognitoUserPoolClientId, true);
    set("NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID", o.cognitoUserPoolClientId, true);
    // auth-options.ts reads COGNITO_APP_CLIENT_ID and COGNITO_APP_CLIENT_SECRET
    set("COGNITO_APP_CLIENT_ID", o.cognitoUserPoolClientId, true);
    set("COGNITO_CLIENT_SECRET", o.cognitoUserPoolClientSecret, true);
    set("COGNITO_APP_CLIENT_SECRET", o.cognitoUserPoolClientSecret, true);
    set("COGNITO_IDENTITY_POOL_ID", o.cognitoIdentityPoolId);
    set("NEXT_PUBLIC_COGNITO_IDENTITY_POOL_ID", o.cognitoIdentityPoolId);

    // Derive region from pool ID (e.g. "ap-south-1_xxx" → "ap-south-1")
    const awsRegion = o.cognitoUserPoolId?.split("_")[0] ?? "ap-south-1";
    set("AWS_REGION", awsRegion);
    set("NEXT_PUBLIC_AWS_REGION", awsRegion);

    // Cognito domain — constructed from prefix
    if (o.cognitoDomainPrefix) {
        const region = awsRegion;
        const domain = `${o.cognitoDomainPrefix}.auth.${region}.amazoncognito.com`;
        set("COGNITO_DOMAIN", domain);
        set("NEXT_PUBLIC_COGNITO_DOMAIN", domain);
        // COGNITO_ISSUER is required by auth-options.ts for the OpenID Connect discovery URL
        if (o.cognitoUserPoolId) {
            set("COGNITO_ISSUER", `https://cognito-idp.${region}.amazonaws.com/${o.cognitoUserPoolId}`);
        }
    } else {
        console.warn("WARN: cognitoDomainPrefix missing — COGNITO_DOMAIN and COGNITO_ISSUER not set.");
    }

    // CloudFront / NextAuth
    set("NEXTAUTH_URL", o.cloudFrontUrl, true);
    set("NEXT_PUBLIC_NEXTAUTH_URL", o.cloudFrontUrl, true);

    // Lambda ARNs
    set("SCHEDULER_LAMBDA_ARN", o.schedulerLambdaArn);

    // ECS / ECR (informational — not required for web-ui runtime but useful for scripts)
    set("ECS_CLUSTER_ARN", o.ecsClusterArn);
    set("ECR_REPOSITORY_URI", o.ecrRepositoryUri);

    return env;
}

// ---------------------------------------------------------------------------
// Step 3: Static values (not from stack outputs)
// ---------------------------------------------------------------------------

const STATIC_ENV: Record<string, string> = {
    // AWS_REGION is derived from cognitoUserPoolId in mapOutputsToEnvVars — not hardcoded here
    NODE_ENV: "production",
    PORT: "3000",
    BEDROCK_MODEL_ID: "amazon.titan-embed-text-v2:0",
    VECTOR_INDEX_NAME: "text-embeddings",
    KB_VECTOR_INDEX_NAME: "knowledge-base-embeddings",
    ASK_AI_GENERATION_MODEL: "global.anthropic.claude-sonnet-4-6",
    LANGFUSE_ENABLED: "false",
    DATA_DIR: "/tmp",
    AWS_USE_STS: "true",
    NEXT_PUBLIC_AWS_USE_STS: "true",
};

// ---------------------------------------------------------------------------
// Step 4: Write web-ui/.env.local
// ---------------------------------------------------------------------------

function writeEnvFile(dynamic: Record<string, string>, statics: Record<string, string>): void {
    const lines: string[] = [
        "# Generated by scripts/generate-env.ts — DO NOT EDIT MANUALLY",
        `# Generated at: ${new Date().toISOString()}`,
        `# Source: pulumi stack output --json --show-secrets --stack ${PULUMI_STACK} (infra/compute/)`,
        "",
        "# ── Dynamic values from Pulumi stack outputs ──────────────────────────────────",
    ];

    for (const [key, value] of Object.entries(dynamic)) {
        lines.push(`${key}=${value}`);
    }

    lines.push("");
    lines.push("# ── Static values ─────────────────────────────────────────────────────────────");

    for (const [key, value] of Object.entries(statics)) {
        lines.push(`${key}=${value}`);
    }

    lines.push("");
    lines.push("# ── Local development overrides (override Pulumi values for localhost) ─────────");
    lines.push("DATABASE_URL=postgresql://nucleus:nucleus_dev@localhost:5432/nucleus?connection_limit=10");
    lines.push("NEXTAUTH_SECRET=local-dev-secret-change-in-prod");
    lines.push("NEXTAUTH_URL=http://localhost:3001");
    lines.push("NEXT_PUBLIC_NEXTAUTH_URL=http://localhost:3001");
    lines.push("");
    lines.push("# PostgreSQL feature flags (set to true to use PG instead of DynamoDB)");
    lines.push("USE_PG_TENANT_CONFIG=true");
    lines.push("USE_PG_ACCOUNTS=true");
    lines.push("USE_PG_SCHEDULES=true");
    lines.push("USE_PG_AUDIT=true");
    lines.push("USE_PG_KB=false");
    lines.push("USE_PG_INVENTORY=false");
    lines.push("USE_PG_AGENT_OPS=false");
    lines.push("DUAL_WRITE_SCHEDULES=false");
    lines.push("");

    const content = lines.join("\n");
    fs.writeFileSync(ENV_OUTPUT_PATH, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
    const outputs = fetchStackOutputs();
    const dynamic = mapOutputsToEnvVars(outputs);
    const allEnv = { ...dynamic, ...STATIC_ENV };

    writeEnvFile(dynamic, STATIC_ENV);

    const totalVars = Object.keys(allEnv).length;
    console.log(`\nWrote ${totalVars} environment variables to: ${ENV_OUTPUT_PATH}`);
    console.log(`  Dynamic (from Pulumi): ${Object.keys(dynamic).length}`);
    console.log(`  Static:               ${Object.keys(STATIC_ENV).length}`);
    console.log("\nDone. You can now run: cd web-ui && npm run dev");
}

main();

---
phase: 11-cutover-cdk-removal
created: 2026-03-30
status: ready
---

# Phase 11: Cutover + CDK Removal — Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Complete the Pulumi migration by:
1. Creating `scripts/generate-env.ts` — reads `pulumi stack output --json` and writes `web-ui/.env.local`
2. Wrapping S3 Vectors (2 indexes) and S3 Tables (Iceberg TableBucket) in `aws.cloudformation.Stack` in the Pulumi compute stack
3. Deleting `lib/networkingStack.ts`, `lib/computeStack.ts`, and `bin/cdkStack.ts` from the repo
4. Verifying WebUIStack CDK deploy still works after cleanup

**CDK destruction is manual** — the user will run `cdk destroy` commands themselves after Pulumi is verified. Phase 11 plans provide the instructions but do NOT automate `cdk destroy`.

</domain>

<decisions>
## Implementation Decisions

### CDK Destruction — MANUAL (user-driven)

**Decision:** Phase 11 plans provide the `cdk destroy` commands as instructions for the user to run manually. No automated `cdk destroy` in plan tasks.

**Rationale:** User explicitly requested manual control over CDK destruction. They will run it themselves once Pulumi is confirmed successful.

**Instructions to include in plan (for user reference):**
```bash
# Destroy in dependency order (ComputeStack first, then NetworkingStack)
npx cdk destroy nucleus-cloud-ops-ComputeStack --profile PLATFORM-ADMIN
npx cdk destroy nucleus-cloud-ops-NetworkingStack --profile PLATFORM-ADMIN
```

### generate-env.ts Script — LOCKED (PULUMI-16)

**Decision:** Create `scripts/generate-env.ts` that:
1. Runs `pulumi stack output --json --show-secrets --stack prod` in `infra/compute/`
2. Maps stack output keys to `web-ui/.env.local` env var names
3. Writes the file with all required vars

**Secret handling:** Use `--show-secrets` flag to get the actual `cognitoUserPoolClientSecret` value. The script runs locally with AWS credentials — the secret is written to `.env.local` which is gitignored.

**Key output → env var mappings (from Phase 8/9/10 stack outputs):**
```
appTableName → APP_TABLE_NAME + NEXT_PUBLIC_APP_TABLE_NAME
auditTableName → AUDIT_TABLE_NAME + NEXT_PUBLIC_AUDIT_TABLE_NAME
checkpointTableName → DYNAMODB_CHECKPOINT_TABLE
writesTableName → DYNAMODB_WRITES_TABLE
checkpointBucketName → CHECKPOINT_S3_BUCKET
chatHistoryTableName → DYNAMODB_CHAT_HISTORY_TABLE
memoryTableName → DYNAMODB_MEMORY_TABLE
usersTeamsTableName → DYNAMODB_USERS_TEAMS_TABLE
cognitoUserPoolId → COGNITO_USER_POOL_ID + NEXT_PUBLIC_COGNITO_USER_POOL_ID
cognitoUserPoolClientId → COGNITO_USER_POOL_CLIENT_ID + NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID
cognitoUserPoolClientSecret → COGNITO_CLIENT_SECRET + COGNITO_APP_CLIENT_SECRET
cognitoIdentityPoolId → COGNITO_IDENTITY_POOL_ID + NEXT_PUBLIC_COGNITO_IDENTITY_POOL_ID
cognitoDomainPrefix → used to construct COGNITO_DOMAIN + NEXT_PUBLIC_COGNITO_DOMAIN
cloudFrontUrl → NEXTAUTH_URL + NEXT_PUBLIC_NEXTAUTH_URL
albDnsName → informational (not a required env var)
schedulerLambdaArn → SCHEDULER_LAMBDA_ARN
inventoryBucketName → INVENTORY_BUCKET_NAME
kbSyncQueueUrl → KB_SYNC_QUEUE_URL
kbStagingBucketName → KB_STAGING_BUCKET_NAME
agentTempBucketName → AGENT_TEMP_BUCKET
agentOpsTableName → AGENT_OPS_TABLE_NAME
inventoryTableName → INVENTORY_TABLE_NAME
```

**Static values (not from stack outputs):**
```
AWS_REGION=us-east-1
NEXT_PUBLIC_AWS_REGION=us-east-1
NODE_ENV=production
PORT=3000
BEDROCK_MODEL_ID=amazon.titan-embed-text-v2:0
VECTOR_INDEX_NAME=text-embeddings
KB_VECTOR_INDEX_NAME=knowledge-base-embeddings
ASK_AI_GENERATION_MODEL=global.anthropic.claude-sonnet-4-6
LANGFUSE_ENABLED=false
DATA_DIR=/tmp
AWS_USE_STS=true
NEXT_PUBLIC_AWS_USE_STS=true
```

**Script location:** `scripts/generate-env.ts`
**Runtime:** `npx tsx scripts/generate-env.ts` (tsx already in devDependencies)

### S3 Vectors + S3 Tables CFN Wrapping — LOCKED (PULUMI-18)

**Decision:** Extract CFN templates from `cdk synth` output and wrap in `aws.cloudformation.Stack` resources in `infra/compute/index.ts`.

**Resources to wrap:**
1. S3 Vectors bucket (`nucleus-cloud-ops-vectors-{account}-{region}`) + 2 vector indexes (`text-embeddings`, `knowledge-base-embeddings`)
2. S3 Tables TableBucket (`nucleus-cloud-ops-inventory-bucket`) + Namespace (`nucleus`) + Iceberg Table (`resources`)

**Process:**
1. Run `npx cdk synth --profile PLATFORM-ADMIN` to generate `cdk.out/`
2. Extract the relevant CFN resource definitions from the synthesized template
3. Create minimal CFN templates (JSON) for S3 Vectors and S3 Tables resources
4. Wrap each in `aws.cloudformation.Stack` in `infra/compute/index.ts`

**Note:** `cdk-s3-vectors` and `@aws-cdk/aws-s3tables-alpha` are already installed. The synth step is a prerequisite task in the plan.

**CFN stack names:**
- `nucleus-cloud-ops-s3-vectors-stack`
- `nucleus-cloud-ops-s3-tables-stack`

### CDK Source File Deletion — LOCKED (PULUMI-17)

**Files to delete:**
- `lib/networkingStack.ts`
- `lib/computeStack.ts`
- `bin/cdkStack.ts`

**Files to keep:**
- `lib/webUIStack.ts` — WebUIStack stays in CDK
- `lib/config.ts` — shared config used by WebUIStack
- All CDK dependencies in `package.json` that WebUIStack needs

**After deletion:** `bin/cdkStack.ts` is gone, so `cdk.json` must be updated to point to a new entry point. Create `bin/webUIStack.ts` that only instantiates WebUIStack.

**cdk.json update:**
```json
{
  "app": "npx ts-node --prefer-ts-exts bin/webUIStack.ts"
}
```

**Verify WebUIStack still works:**
```bash
npx cdk synth --profile PLATFORM-ADMIN
```
Should synthesize without errors (WebUIStack only).

### WebUIStack CDK Entry Point — LOCKED

**Decision:** Create `bin/webUIStack.ts` as the new CDK entry point after deleting `bin/cdkStack.ts`.

**Content:**
```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WebUIStack } from '../lib/webUIStack';
import { getConfig } from '../lib/config';

const app = new cdk.App();
const config = getConfig();
const appName = config.appName || 'nucleus-cloud-ops';

new WebUIStack(app, `${appName}-WebUIStack`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
```

**Note:** Check `lib/webUIStack.ts` constructor signature to ensure props match.

### Claude's Discretion

- Exact CFN template structure for S3 Vectors + S3 Tables (extract from cdk synth output)
- Whether to use `aws.cloudformation.Stack` with inline template body or a template file
- Error handling in `generate-env.ts` (missing outputs, pulumi CLI not found)
- Whether `bin/webUIStack.ts` needs additional props from `lib/config.ts`

</decisions>

<specifics>
## Specific Requirements

- `generate-env.ts` must use `--show-secrets` to get the real Cognito client secret — without it, the value is `[secret]` which breaks auth
- The script should write to `web-ui/.env.local` (already gitignored) — not `.env` at root
- S3 Vectors + S3 Tables CFN wrapping is a prerequisite for PULUMI-18 — `cdk synth` must run before the plan can extract templates
- `lib/webUIStack.ts` imports from `lib/config.ts` — verify `getConfig()` or equivalent still works after removing NetworkingStack/ComputeStack imports
- CDK `package.json` deps for WebUIStack must be preserved: `aws-cdk-lib`, `constructs`, `@aws-cdk/aws-s3tables-alpha`, `cdk-s3-vectors`, `cdk-s3-vectors` — do NOT remove these

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — PULUMI-16 through PULUMI-18 define acceptance criteria for this phase

### CDK Source Files (to delete)
- `lib/networkingStack.ts` — CDK NetworkingStack (to be deleted)
- `lib/computeStack.ts` — CDK ComputeStack (to be deleted)
- `bin/cdkStack.ts` — CDK app entry point (to be deleted, replaced by bin/webUIStack.ts)

### CDK Source Files (to keep)
- `lib/webUIStack.ts` — WebUIStack stays in CDK; check constructor signature for bin/webUIStack.ts
- `lib/config.ts` — shared config; verify it doesn't import from deleted stacks

### Pulumi Stack Outputs
- `infra/compute/index.ts` — all 49 stack outputs from Phases 8-10; generate-env.ts reads these

### Prior Phase Context
- `.planning/phases/10-ecs-alb-cloudfront/10-CONTEXT.md` — container env var list (maps to .env.local vars)

</canonical_refs>

<code_context>
## Existing Code Insights

### scripts/ directory
Check if `scripts/` directory exists and what's already there — `generate-env.ts` goes here.

### cdk.json
Currently points to `bin/cdkStack.ts`. Must be updated to `bin/webUIStack.ts` after deletion.

### lib/config.ts
Shared config used by both CDK stacks. Verify it doesn't import from networkingStack or computeStack — if it does, those imports must be removed.

### S3 Vectors + S3 Tables in CDK
`lib/computeStack.ts` lines 272-604 contain the S3 Vectors and S3 Tables definitions using alpha CDK packages. `cdk synth` will generate CFN JSON for these — extract and wrap in Pulumi.

</code_context>

<deferred>
## Deferred Ideas

- **Automated CDK destruction** — user will run `cdk destroy` manually after Pulumi verification
- **WebUIStack migration to Pulumi** — explicitly out of scope for v2.0 (stays in CDK)
- **Production PostgreSQL (RDS/Aurora)** — from v1.0 future requirements, not in v2.0 scope
- **CloudWatch alarms for PostgreSQL** — future requirement

</deferred>

---

*Phase: 11-cutover-cdk-removal*
*Context gathered: 2026-03-30*

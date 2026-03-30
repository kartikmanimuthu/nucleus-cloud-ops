---
phase: 08-data-layer
created: 2026-03-30
status: ready
---

# Phase 8: Data Layer — Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Deploy all stateful AWS resources (DynamoDB tables, S3 buckets, SQS queues + DLQs, CloudWatch alarm, Cognito) in `infra/compute/` via Pulumi with retention protection and correct configurations. Exports all resource identifiers as stack outputs for Phase 10 (ECS) to consume.

This is a direct CDK → Pulumi translation of the data/stateful sections of `lib/computeStack.ts`. CDK resources stay live throughout — Pulumi creates parallel new resources (blue/green). Lambda functions and ECS are Phase 9 and 10 respectively.

**S3 Vectors bucket is explicitly deferred to Phase 11** — no native `@pulumi/aws` support; will be wrapped in `aws.cloudformation.Stack`.

</domain>

<decisions>
## Implementation Decisions

### File Organization — LOCKED

**Decision:** Keep everything in `infra/compute/index.ts` — single file, no domain splits.

**Rationale:** Matches Phase 7 networking pattern (single `index.ts`). Simpler import graph. User preference.

### Removal Policy — LOCKED

**Decision:** `retainOnDelete: true` on ALL DynamoDB tables and ALL S3 buckets.

**Rationale:** Matches REQUIREMENTS.md. Protects against accidental `pulumi destroy` during blue/green period when CDK is still live. If a Pulumi stack is torn down and redeployed, resources survive.

**SQS queues:** No `retainOnDelete` — queues are stateless infrastructure, safe to recreate.
**Cognito:** No `retainOnDelete` — user pool recreation requires re-enrollment; acceptable since CDK pool stays live during migration.

### Stack Outputs — LOCKED

**Decision:** Phase 8 exports ALL resource identifiers as stack outputs now. Phase 10 reads them via `requireOutput()`.

**Required exports (minimum):**
- All 9 DynamoDB table names
- All 4 S3 bucket names + ARNs
- VectorProcessingQueue URL + ARN, VectorProcessingDLQ ARN
- KBSyncQueue URL + ARN, KBSyncDLQ ARN
- Cognito UserPool ID, UserPool ARN, UserPoolClient ID, IdentityPool ID
- Cognito domain prefix (for env var `COGNITO_DOMAIN`)

### Cognito Domain Prefix — LOCKED

**Decision:** Match CDK exactly — use `aws.getCallerIdentity()` to get account ID and construct `nucleus-cloud-ops-web-ui-auth-{accountId}`.

**Implementation pattern:**
```typescript
const callerIdentity = await aws.getCallerIdentity({});
const domainPrefix = `nucleus-cloud-ops-web-ui-auth-${callerIdentity.accountId}`;
```

Note: `aws.getCallerIdentity()` returns a `Promise` — must be called at the top of `index.ts` and awaited before resource creation. Pulumi supports top-level `async` in `index.ts`.

### Resource Naming — Match CDK Exactly

All physical names derived from CDK source. `appName = "nucleus-cloud-ops"`, `webUiStackName = "nucleus-cloud-ops-web-ui"`.

**DynamoDB tables:**
| Table | Physical Name |
|-------|--------------|
| AppTable | `nucleus-cloud-ops-app-table` |
| AuditTable | `nucleus-cloud-ops-audit-table` |
| InventoryTable | `nucleus-cloud-ops-inventory-table` |
| UsersTeamsTable | `nucleus-cloud-ops-web-ui-users-teams` |
| CheckpointTable | `nucleus-cloud-ops-checkpoints-table` |
| WritesTable | `nucleus-cloud-ops-checkpoint-writes-v2-table` |
| ChatHistoryTable | `nucleus-cloud-ops-chat-history` |
| MemoryTable | `nucleus-cloud-ops-memory` |
| AgentOpsTable | `nucleus-cloud-ops-agent-ops` |

**S3 buckets** (account + region suffix required for global uniqueness):
| Bucket | Physical Name Pattern |
|--------|----------------------|
| CheckpointBucket | `nucleus-cloud-ops-checkpoints-bucket-{account}-{region}` |
| AgentTempBucket | `nucleus-cloud-ops-agent-temp-{account}-{region}` |
| KBStagingBucket | `nucleus-cloud-ops-kb-staging-{account}-{region}` |
| InventoryBucket | `nucleus-cloud-ops-inventory-{account}-{region}` |

**SQS queues:**
| Queue | Physical Name |
|-------|--------------|
| VectorProcessingQueue | `nucleus-cloud-ops-vector-processing-queue` |
| VectorProcessingDLQ | `nucleus-cloud-ops-vector-processing-dlq` |
| KBSyncQueue | `nucleus-cloud-ops-kb-sync-queue` |
| KBSyncDLQ | `nucleus-cloud-ops-kb-sync-dlq` |

**Cognito:**
| Resource | Physical Name |
|----------|--------------|
| UserPool | `nucleus-cloud-ops-web-ui-user-pool` (CDK auto-names; use explicit name) |
| UserPoolDomain | `nucleus-cloud-ops-web-ui-auth-{accountId}` |
| UserPoolClient | `nucleus-cloud-ops-web-ui-app-client` |
| IdentityPool | `nucleus-cloud-ops-web-ui-identity-pool` |
| AuthenticatedRole | `nucleus-cloud-ops-web-ui-authenticated-role` |

### DynamoDB Table Schemas — Match CDK Exactly

All tables use PAY_PER_REQUEST billing. All have `retainOnDelete: true`.

| Table | PK | SK | GSIs | TTL attr |
|-------|----|----|------|----------|
| AppTable | `pk` (S) | `sk` (S) | GSI1 (gsi1pk/gsi1sk), GSI2 (gsi2pk/gsi2sk), GSI3 (gsi3pk/gsi3sk) | `ttl` |
| AuditTable | `pk` (S) | `sk` (S) | GSI1, GSI2, GSI3 (same pattern) | `expire_at` |
| InventoryTable | `pk` (S) | `sk` (S) | GSI1, GSI2, GSI3 (same pattern) | `ttl` |
| UsersTeamsTable | `PK` (S) | `SK` (S) | EntityTypeIndex (EntityType, ALL projection) | none |
| CheckpointTable | `thread_id` (S) | `checkpoint_id` (S) | none | `ttl` |
| WritesTable | `thread_id_checkpoint_id_checkpoint_ns` (S) | `task_id_idx` (S) | none | `ttl` |
| ChatHistoryTable | `userId` (S) | `sessionId` (S) | none | `ttl` |
| MemoryTable | `user_id` (S) | `namespace_key` (S) | none | `ttl` |
| AgentOpsTable | `PK` (S) | `SK` (S) | GSI1 (GSI1PK/GSI1SK, ALL projection) | `ttl` |

### S3 Bucket Lifecycle Rules — Match CDK Exactly

| Bucket | Lifecycle Rules |
|--------|----------------|
| CheckpointBucket | Expire all objects after 30 days |
| AgentTempBucket | Expire all objects after 1 day |
| KBStagingBucket | Expire all objects after 1 day |
| InventoryBucket | `raw/` prefix: expire after 365 days; `exports/` prefix: expire after 7 days |

### SQS Queue Configuration — Match CDK Exactly

**VectorProcessingQueue:**
- visibilityTimeoutSeconds: 900 (must be >= Lambda timeout of 15 min)
- receiveWaitTimeSeconds: 20 (long polling)
- DLQ: VectorProcessingDLQ, maxReceiveCount: 3
- Resource policy: allow `s3.amazonaws.com` to `sqs:SendMessage` from InventoryBucket ARN

**VectorProcessingDLQ:**
- messageRetentionSeconds: 1209600 (14 days)

**KBSyncQueue:**
- visibilityTimeoutSeconds: 900
- receiveWaitTimeSeconds: 20
- DLQ: KBSyncDLQ, maxReceiveCount: 3

**KBSyncDLQ:**
- messageRetentionSeconds: 1209600 (14 days)

### CloudWatch Alarm — Match CDK Exactly

One alarm on VectorProcessingDLQ:
- alarmName: `nucleus-cloud-ops-vector-dlq-depth`
- metric: `ApproximateNumberOfMessagesVisible` on VectorProcessingDLQ
- threshold: 1, evaluationPeriods: 1
- comparisonOperator: GreaterThanOrEqualToThreshold
- treatMissingData: notBreaching

### Cognito Configuration — Match CDK Exactly

**UserPool:**
- selfSignUpEnabled: false (CDK default — no self-registration)
- autoVerifiedAttributes: `["email"]`
- signInAliases: email only, case-insensitive
- passwordPolicy: minLength 8, requireDigits, requireLowercase; NO requireSymbols, NO requireUppercase
- accountRecovery: EMAIL_ONLY
- tempPasswordValidity: 7 days

**UserPoolClient:**
- generateSecret: true (secret stored as Pulumi secret output — NOT plaintext)
- authFlows: userPassword + userSrp
- OAuth flows: authorizationCodeGrant only (no implicitCodeGrant)
- OAuth scopes: openid, email, profile, aws.cognito.signin.user.admin
- callbackUrls: `http://localhost:3000/api/auth/callback/cognito` + `{appUrl}/api/auth/callback/cognito`
- logoutUrls: `http://localhost:3000` + `{appUrl}`
- preventUserExistenceErrors: true
- enableTokenRevocation: true
- accessTokenValidity: 1 hour, idTokenValidity: 1 hour, refreshTokenValidity: 30 days

**IdentityPool:**
- allowUnauthenticatedIdentities: false
- cognitoIdentityProviders: UserPoolClient + UserPool

**AuthenticatedRole:** IAM role with Cognito federated principal, standard cognito-sync + dynamodb permissions on UsersTeamsTable.

### appUrl Config Value

`appUrl` is read from Pulumi config (same pattern as networking's `vpcCidr`). Add to `infra/compute/Pulumi.prod.yaml`:
```yaml
config:
  nucleus-compute:appUrl: https://your-cloudfront-url.cloudfront.net
```

This is a placeholder until Phase 10 (CloudFront) creates the real URL. For Phase 8, the Cognito callback URLs will include this placeholder — acceptable since Cognito isn't being used until Phase 11 cutover.

### Claude's Discretion

- Exact Pulumi output key names (keep consistent with CDK CfnOutput names where possible)
- Whether to use `pulumi.interpolate` vs `pulumi.all()` for bucket names with account/region
- Top-level async pattern for `aws.getCallerIdentity()` — use standard Pulumi async index.ts pattern

</decisions>

<specifics>
## Specific Requirements

- S3 Vectors bucket (`nucleus-cloud-ops-vectors-{account}-{region}`) is **explicitly excluded** from Phase 8 — deferred to Phase 11 where it will be wrapped in `aws.cloudformation.Stack`
- The VectorProcessingQueue resource policy (allowing S3 to send messages) must be created as a separate `aws.sqs.QueuePolicy` resource — Pulumi doesn't have an inline equivalent of CDK's `addToResourcePolicy`
- Cognito client secret must be a `pulumi.secret()` output — never plaintext in stack state

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### CDK Source of Truth
- `lib/computeStack.ts` — Complete CDK definitions for all 9 DynamoDB tables, 4 S3 buckets, 2 SQS queue pairs, CloudWatch alarm, and full Cognito setup. Lines 60–800 cover data layer resources.

### Prior Phase Context
- `.planning/phases/07-networking/07-CONTEXT.md` — Established patterns: explicit physical names, `@pulumi/aws` primitives only, Pulumi config pattern, StackReference format
- `.planning/research/PITFALLS.md` — Explicit physical names requirement, retainOnDelete rationale
- `.planning/research/STACK.md` — Package versions, tsconfig pattern

### Requirements
- `.planning/REQUIREMENTS.md` — PULUMI-04 through PULUMI-07 define acceptance criteria for this phase

### Existing Compute Scaffold
- `infra/compute/index.ts` — Current scaffold (StackReference wiring only) — Phase 8 replaces this with full data layer implementation
- `infra/compute/Pulumi.prod.yaml` — Stack config — Phase 8 adds `appUrl` config value

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Patterns from Phase 7
- `infra/networking/index.ts` — Pattern for top-level async, Pulumi config reading, stack output exports
- `infra/networking/Pulumi.prod.yaml` — Config file pattern to follow for `infra/compute/Pulumi.prod.yaml`

### Integration Points
- `infra/compute/index.ts` already has StackReference wiring for networking outputs — Phase 8 adds data resources below the existing StackReference block
- Phase 9 (Lambda) will import queue URLs and table names from Phase 8 stack outputs
- Phase 10 (ECS) will import all 30+ resource identifiers from Phase 8 stack outputs via `requireOutput()`

### Account/Region in Resource Names
- S3 bucket names include `{account}-{region}` suffix — use `aws.getCallerIdentity()` for account and `aws.config.region` for region
- Both are available at the top of `index.ts` alongside the `getCallerIdentity()` call for Cognito domain

</code_context>

<deferred>
## Deferred Ideas

- **S3 Vectors bucket** (`nucleus-cloud-ops-vectors-{account}-{region}`) — deferred to Phase 11; no native `@pulumi/aws` support; will be wrapped in `aws.cloudformation.Stack` using CFN template from `cdk synth`
- **S3 Tables (Iceberg TableBucket)** — same deferral to Phase 11
- **IAM roles for Lambda/ECS** — deferred to Phase 9/10 where the compute resources are defined; IAM roles belong with the resources they serve

</deferred>

---

*Phase: 08-data-layer*
*Context gathered: 2026-03-30*

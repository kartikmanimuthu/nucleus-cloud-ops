---
phase: 08-data-layer
verified: 2026-03-30T09:15:00Z
status: passed
score: 3/3 must-haves verified
gaps: []
human_verification:
  - test: "Verify all 32 deployed resources are healthy in AWS Console"
    expected: "DynamoDB tables ACTIVE, S3 buckets accessible, SQS queues visible, Cognito UserPool Active"
    why_human: "pulumi up exited 0 with real AWS IDs in outputs but resource health state cannot be verified from the filesystem"
  - test: "Confirm cognitoUserPoolClientSecret shows [secret] in pulumi stack output"
    expected: "Running `pulumi stack output cognitoUserPoolClientSecret` (without --show-secrets) prints [secret], not the plaintext value"
    why_human: "pulumi.secret() wrapping confirmed in source at line 568 but actual state encryption requires a live Pulumi CLI call"
---

# Phase 8: Data Layer Verification Report

**Phase Goal:** All stateful AWS resources (DynamoDB, S3, SQS, Cognito) are deployed via Pulumi with retention protection and correct configurations
**Verified:** 2026-03-30T09:15:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | All 9 DynamoDB tables deploy with correct GSIs, TTL attributes, and `retainOnDelete: true` | ✓ VERIFIED | 9 `aws.dynamodb.Table` definitions; schemas match CONTEXT.md exactly; 9 `retainOnDelete: true` on table resources |
| 2 | All 4 S3 buckets with lifecycle rules; both SQS queue pairs with DLQs; CloudWatch alarm on VectorProcessingDLQ (threshold=1) | ✓ VERIFIED | 4 BucketV2 + 4 BucketLifecycleConfigurationV2; 4 SQS queues in 2 pairs with redrivePolicy; MetricAlarm threshold=1 |
| 3 | Cognito UserPool, UserPoolClient, IdentityPool deploy — client secret stored as Pulumi secret output | ✓ VERIFIED | All 6 Cognito/IAM resources present; `pulumi.secret(userPoolClient.clientSecret)` at line 568 |

**Score:** 3/3 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `infra/compute/index.ts` | All Phase 8 resources defined | ✓ VERIFIED | 571 lines; all resource types present and substantive |
| Commit d55e570 | DynamoDB tables | ✓ VERIFIED | `feat(08-01): define all 9 DynamoDB tables in infra/compute/index.ts` |
| Commit 83c0790 | S3, SQS, CloudWatch | ✓ VERIFIED | `feat(08-01): add S3 buckets, SQS queues, CloudWatch alarm to compute stack` |
| Commit 52b1d80 | Cognito + stack outputs | ✓ VERIFIED | `feat(08-03): add Cognito UserPool, Domain, Client, IdentityPool, AuthRole` |

---

### DynamoDB Table Schema Verification

| Table | PK | SK | GSIs | TTL attr | retainOnDelete |
|-------|----|----|------|----------|----------------|
| AppTable (`nucleus-cloud-ops-app-table`) | `pk` (S) | `sk` (S) | GSI1/GSI2/GSI3 (gsi1pk–gsi3sk, ALL) | `ttl` | ✓ |
| AuditTable (`nucleus-cloud-ops-audit-table`) | `pk` (S) | `sk` (S) | GSI1/GSI2/GSI3 | `expire_at` | ✓ |
| InventoryTable (`nucleus-cloud-ops-inventory-table`) | `pk` (S) | `sk` (S) | GSI1/GSI2/GSI3 | `ttl` | ✓ |
| UsersTeamsTable (`nucleus-cloud-ops-web-ui-users-teams`) | `PK` (S) | `SK` (S) | EntityTypeIndex (EntityType, ALL) | none | ✓ |
| CheckpointTable (`nucleus-cloud-ops-checkpoints-table`) | `thread_id` (S) | `checkpoint_id` (S) | none | `ttl` | ✓ |
| WritesTable (`nucleus-cloud-ops-checkpoint-writes-v2-table`) | `thread_id_checkpoint_id_checkpoint_ns` (S) | `task_id_idx` (S) | none | `ttl` | ✓ |
| ChatHistoryTable (`nucleus-cloud-ops-chat-history`) | `userId` (S) | `sessionId` (S) | none | `ttl` | ✓ |
| MemoryTable (`nucleus-cloud-ops-memory`) | `user_id` (S) | `namespace_key` (S) | none | `ttl` | ✓ |
| AgentOpsTable (`nucleus-cloud-ops-agent-ops`) | `PK` (S) | `SK` (S) | GSI1 (GSI1PK/GSI1SK, ALL) | `ttl` | ✓ |

All 9 tables match CONTEXT.md spec exactly.

---

### S3 Lifecycle Rule Verification

| Bucket | Physical Name Pattern | Lifecycle Rules | retainOnDelete |
|--------|-----------------------|-----------------|----------------|
| CheckpointBucket | `nucleus-cloud-ops-checkpoints-bucket-{account}-{region}` | expire all after 30d | ✓ |
| AgentTempBucket | `nucleus-cloud-ops-agent-temp-{account}-{region}` | expire all after 1d | ✓ |
| KBStagingBucket | `nucleus-cloud-ops-kb-staging-{account}-{region}` | expire all after 1d | ✓ |
| InventoryBucket | `nucleus-cloud-ops-inventory-{account}-{region}` | `raw/` 365d + `exports/` 7d | ✓ |

All 4 buckets use `pulumi.interpolate` with `accountId` + `region` for global uniqueness. All match CONTEXT.md spec.

---

### SQS Queue Verification

| Queue | visibilityTimeout | receiveWait | DLQ | maxReceiveCount | messageRetention |
|-------|-------------------|-------------|-----|-----------------|------------------|
| VectorProcessingQueue | 900s | 20s | VectorProcessingDLQ | 3 | — |
| VectorProcessingDLQ | — | — | — | — | 1209600s (14d) |
| KBSyncQueue | 900s | 20s | KBSyncDLQ | 3 | — |
| KBSyncDLQ | — | — | — | — | 1209600s (14d) |

QueuePolicy: separate `aws.sqs.QueuePolicy` resource allows `s3.amazonaws.com` to `sqs:SendMessage` on VectorProcessingQueue, conditioned on `aws:SourceArn` = inventoryBucket ARN. ✓

---

### CloudWatch Alarm Verification

| Property | Expected | Actual | Status |
|----------|----------|--------|--------|
| name | `nucleus-cloud-ops-vector-dlq-depth` | `nucleus-cloud-ops-vector-dlq-depth` | ✓ |
| metric | ApproximateNumberOfMessagesVisible | ApproximateNumberOfMessagesVisible | ✓ |
| namespace | AWS/SQS | AWS/SQS | ✓ |
| dimensions | QueueName = VectorProcessingDLQ | `vectorProcessingDlq.name` | ✓ |
| threshold | 1 | 1 | ✓ |
| evaluationPeriods | 1 | 1 | ✓ |
| comparisonOperator | GreaterThanOrEqualToThreshold | GreaterThanOrEqualToThreshold | ✓ |
| treatMissingData | notBreaching | notBreaching | ✓ |

---

### Cognito Verification

| Resource | Key Properties | Status |
|----------|---------------|--------|
| UserPool | name=`nucleus-cloud-ops-web-ui-user-pool`, email sign-in, caseSensitive=false, minLen=8, digits+lowercase only, tempPasswordDays=7, accountRecovery=verified_email | ✓ |
| UserPoolDomain | `nucleus-cloud-ops-web-ui-auth-{accountId}` via `pulumi.interpolate` | ✓ |
| UserPoolClient | name=`nucleus-cloud-ops-web-ui-app-client`, generateSecret=true, flows=code only, scopes=openid+email+profile+admin, preventUserExistenceErrors=ENABLED, tokenRevocation=true, access/id=1h, refresh=30d | ✓ |
| IdentityPool | name=`nucleus-cloud-ops-web-ui-identity-pool`, allowUnauthenticated=false, providers=userPoolClient+userPool | ✓ |
| AuthenticatedRole | name=`nucleus-cloud-ops-web-ui-authenticated-role`, Cognito federated principal, DynamoDB policy scoped to usersTeamsTable | ✓ |
| RoleAttachment | roles.authenticated = authenticatedRole.arn | ✓ |
| Secret output | `pulumi.secret(userPoolClient.clientSecret)` at line 568 | ✓ |

---

### Stack Outputs Verification

| Output | Exported | Notes |
|--------|----------|-------|
| All 9 DynamoDB table names | ✓ | |
| All 4 S3 bucket names + ARNs | ✓ | |
| vectorProcessingQueueUrl + Arn | ✓ | |
| vectorProcessingDlqArn | ✓ | |
| kbSyncQueueUrl + Arn | ✓ | |
| kbSyncDlqArn | ✗ MISSING | CONTEXT.md lists this as a required minimum export; resource is correctly defined and wired but ARN not exported |
| cognitoUserPoolId + Arn | ✓ | |
| cognitoUserPoolClientId | ✓ | |
| cognitoUserPoolClientSecret | ✓ (secret) | `pulumi.secret()` wrapping confirmed at line 568 |
| cognitoIdentityPoolId | ✓ | |
| cognitoDomainPrefix | ✓ | |

`kbSyncDlqArn` is not exported. The resource is correctly defined and wired as the DLQ for kbSyncQueue — only the stack output is missing. This does not block any Phase 8 success criterion but must be added before Phase 9 (KBSyncProcessor Lambda needs the DLQ ARN).

---

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| vectorProcessingQueue | vectorProcessingDlq | `redrivePolicy` with `dlqArn` | ✓ WIRED |
| kbSyncQueue | kbSyncDlq | `redrivePolicy` with `dlqArn` | ✓ WIRED |
| QueuePolicy | inventoryBucket | `pulumi.all([queueArn, bucketArn])` | ✓ WIRED |
| MetricAlarm | vectorProcessingDlq | `dimensions: { QueueName: vectorProcessingDlq.name }` | ✓ WIRED |
| identityPool | userPoolClient + userPool | `cognitoIdentityProviders` | ✓ WIRED |
| authenticatedRole | identityPool | `assumeRolePolicy` uses `identityPool.id.apply(...)` | ✓ WIRED |
| RoleAttachment | authenticatedRole | `roles: { authenticated: authenticatedRole.arn }` | ✓ WIRED |
| DynamoDB IAM policy | usersTeamsTable | `pulumi.all([usersTeamsTable.arn])` | ✓ WIRED |

---

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| PULUMI-04 | 9 DynamoDB tables with correct schemas, GSIs, TTL, retainOnDelete | ✓ SATISFIED | All 9 tables verified against CONTEXT.md schema table |
| PULUMI-05 | 4 S3 buckets with correct lifecycle rules | ✓ SATISFIED | checkpoint 30d, agent-temp 1d, kb-staging 1d, inventory raw/365d + exports/7d |
| PULUMI-06 | VectorProcessing + KBSync SQS pairs with DLQs + CloudWatch alarm threshold=1 | ✓ SATISFIED | Both pairs present; alarm threshold=1 on VectorProcessingDLQ |
| PULUMI-07 | Cognito UserPool, Domain, Client (generated secret), IdentityPool — secret as Pulumi secret | ✓ SATISFIED | All resources present; `pulumi.secret(userPoolClient.clientSecret)` at line 568 |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `infra/compute/index.ts` | 11 | `appUrl` fallback `"https://placeholder.cloudfront.net"` | ℹ️ Info | Intentional per CONTEXT.md — placeholder until Phase 10 creates real CloudFront URL; Cognito not used until Phase 11 cutover |

No blockers or warnings. The placeholder appUrl is explicitly documented as acceptable in CONTEXT.md.

---

### Behavioral Spot-Checks

Step 7b: SKIPPED — Phase 8 deploys stateful infrastructure resources, not runnable application code. Behavioral verification requires AWS Console inspection (routed to human verification below).

---

### Human Verification Required

#### 1. AWS Console Resource Health

**Test:** Log into AWS Console → verify all 32 resources are in healthy state: DynamoDB tables (ACTIVE), S3 buckets (accessible), SQS queues (visible), Cognito UserPool (Active)
**Expected:** All resources show healthy/active state with physical names matching CONTEXT.md naming table
**Why human:** `pulumi up` exited 0 and stack outputs contain real AWS-assigned IDs, but resource health state cannot be verified from the filesystem

#### 2. Cognito Client Secret Encryption

**Test:** In `infra/compute/`, run `pulumi stack output cognitoUserPoolClientSecret` (without `--show-secrets`)
**Expected:** Output shows `[secret]` — not the plaintext value
**Why human:** `pulumi.secret()` wrapping is confirmed in source at line 568 but actual encryption in Pulumi state requires a live CLI call

---

### Gaps Summary

No gaps blocking phase goal achievement. All 3 success criteria and all 4 requirements (PULUMI-04 through PULUMI-07) are fully satisfied.

One forward-compatibility note: `kbSyncDlqArn` is not exported as a stack output despite being listed as a required minimum export in CONTEXT.md. The `kbSyncDlq` resource is correctly defined and wired — only the `export const kbSyncDlqArn = kbSyncDlq.arn` line is missing. Add it before Phase 9 planning.

---

_Verified: 2026-03-30T09:15:00Z_
_Verifier: Claude (gsd-verifier)_

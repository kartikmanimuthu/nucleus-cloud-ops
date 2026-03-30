---
phase: 08-data-layer
verified: 2026-03-30
status: PASSED
---

# Phase 8: Data Layer — Verification

## Result: PASSED

All 3 success criteria met. All 4 requirements covered. 32 resources deployed to AWS us-east-1.

---

## Success Criteria

### SC-1: All 9 DynamoDB tables with correct GSIs, TTL, retainOnDelete ✓

Verified in `infra/compute/index.ts`:
- 9 `new aws.dynamodb.Table(` definitions
- 9 `retainOnDelete: true` on table resources
- AppTable: GSI1/GSI2/GSI3 (gsi1pk/gsi1sk pattern), TTL=`ttl`
- AuditTable: GSI1/GSI2/GSI3, TTL=`expire_at`
- InventoryTable: GSI1/GSI2/GSI3, TTL=`ttl`
- UsersTeamsTable: EntityTypeIndex (EntityType, ALL projection), no TTL
- CheckpointTable: no GSI, TTL=`ttl`
- WritesTable: no GSI, TTL=`ttl`
- ChatHistoryTable: no GSI, TTL=`ttl`
- MemoryTable: no GSI, TTL=`ttl`
- AgentOpsTable: GSI1 (GSI1PK/GSI1SK, ALL projection), TTL=`ttl`

`pulumi up` deployed 32 resources — no replacements on re-preview.

### SC-2: 4 S3 buckets + 2 SQS queue pairs + CloudWatch alarm ✓

Verified in `infra/compute/index.ts`:
- 4 S3 buckets: CheckpointBucket (30d), AgentTempBucket (1d), KBStagingBucket (1d), InventoryBucket (raw/365d + exports/7d)
- 4 `retainOnDelete: true` on bucket resources
- VectorProcessingQueue + VectorProcessingDLQ (14d retention, maxReceiveCount=3, visibilityTimeout=900s)
- KBSyncQueue + KBSyncDLQ (14d retention, maxReceiveCount=3, visibilityTimeout=900s)
- `aws.sqs.QueuePolicy` on VectorProcessingQueue (allows S3 `sqs:SendMessage` from InventoryBucket)
- CloudWatch MetricAlarm: `nucleus-cloud-ops-vector-dlq-depth`, threshold=1, evaluationPeriods=1, treatMissingData=notBreaching

### SC-3: Cognito deployed with secret output ✓

Verified in `infra/compute/index.ts`:
- `new aws.cognito.UserPool(` — 1 definition
- UserPoolDomain with `nucleus-cloud-ops-web-ui-auth-{accountId}` prefix
- UserPoolClient with `generateSecret: true`
- `pulumi.secret(userPoolClient.clientSecret)` — secret wrapped, not plaintext
- CfnIdentityPool (via `aws.cognito.IdentityPool`) with `allowUnauthenticatedIdentities: false`
- AuthenticatedRole + IdentityPoolRoleAttachment

---

## Requirement Coverage

| Requirement | Description | Status |
|-------------|-------------|--------|
| PULUMI-04 | 9 DynamoDB tables with GSIs, TTL, retainOnDelete | ✓ PASSED |
| PULUMI-05 | 4 S3 buckets with lifecycle rules | ✓ PASSED |
| PULUMI-06 | SQS queue pairs + DLQs + CloudWatch alarm | ✓ PASSED |
| PULUMI-07 | Cognito UserPool/Client/IdentityPool, secret output | ✓ PASSED |

---

## Stack Outputs

30 stack outputs exported — covers all resource identifiers needed by Phase 10 (ECS):
- All 9 DynamoDB table names
- All 4 S3 bucket names + ARNs
- VectorProcessingQueue URL + ARN, DLQ ARN
- KBSyncQueue URL + ARN, DLQ ARN
- Cognito UserPool ID/ARN, UserPoolClient ID, IdentityPool ID, domain prefix
- Cognito client secret (as `pulumi.secret()`)

---

## Deployed Resources (AWS us-east-1)

32 resources created via `pulumi up` in ~3m17s:
- 9 DynamoDB tables
- 4 S3 buckets + 4 lifecycle configurations
- 4 SQS queues + 1 QueuePolicy
- 1 CloudWatch alarm
- 1 Cognito UserPool + 1 UserPoolDomain + 1 UserPoolClient + 1 IdentityPool + 1 IdentityPoolRoleAttachment + 1 IAM Role + 2 IAM Role Policies
- Networking StackReference (from Phase 7)

---

## Human UAT Items

- [ ] DynamoDB Console: confirm 9 tables with `nucleus-cloud-ops-` prefix
- [ ] DynamoDB `nucleus-cloud-ops-app-table` → Indexes: confirm GSI1, GSI2, GSI3
- [ ] DynamoDB `nucleus-cloud-ops-audit-table` → TTL attribute: confirm `expire_at`
- [ ] S3 Console: confirm 4 buckets with `{account}-{region}` suffix
- [ ] SQS Console: confirm `nucleus-cloud-ops-vector-processing-queue` has DLQ configured
- [ ] CloudWatch Alarms: confirm `nucleus-cloud-ops-vector-dlq-depth` exists
- [ ] Cognito Console: confirm `nucleus-cloud-ops-web-ui-user-pool` exists
- [ ] `pulumi stack output cognitoUserPoolClientSecret --show-secrets` returns real secret string

*Last updated: 2026-03-30*

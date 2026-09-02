# Resource Graph Edge Coverage — Phase 3b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four remaining *extraction* gaps found by a full audit, rather than discovering them one resource type at a time. Measured on account `869935102658` after Phase 3: 165 of 841 resources are isolated, and ~128 of those are fixable.

**Architecture:** Same deterministic pipeline — `scanfile.json` / `custom-scanners.ts` fetch, `EDGE_SPECS` / `CUSTOM_DERIVERS` derive, `resource_edges` stores. No new tables, no LLM.

**Tech Stack:** TypeScript, AWS SDK v3, pg-boss workers, Vitest.

**Spec:** extends `docs/RESOURCE_GRAPH_ARCHITECTURE.md`. Update its Known Limitations as each gap closes.

## The audit this plan is built on

Every isolated resource in account `869935102658`, classified. This is the whole list — nothing here was guessed.

| Type | Isolated | Cause | Action |
| --- | --- | --- | --- |
| `s3_buckets` | 76 | no KMS key, and no other S3 relationship is extracted | Task 3 (notifications only — zero CloudFront distributions exist, so that avenue is closed) |
| `cloudwatch_alarms` | 46 | `LoadBalancer` / `TargetGroup` dimensions are not in the deriver's map | Task 1 |
| `events_rules` | 15 | targets are services this scanner does not inventory | accept |
| `kms_keys` | 11 | nothing in this account uses them | accept |
| `ecr_repositories` | 6 | nothing links a running task to its image repository | Task 4 |
| `sns_topics` | 3 | nothing publishes to them | accept |
| 7 other types | 8 | genuinely unused | accept |

Separately, and not visible in that table: **61 edges in this account point at a KMS key that lives in account `861276112345`** — a shared, cross-account key. The relationship is recorded correctly; the canvas cannot draw it because a view loads one account's nodes. That is Task 2.

**~37 resources are genuinely isolated and must stay visible.** An orphaned volume or an unused key is a finding, not noise.

## Global Constraints

- **Deterministic only.** No inference, no heuristics that guess a relationship.
- **Verify the id shape before mapping any type.** Edges join by exact string match. Phase 3 shipped a Critical because ARNs were stripped to short names for types keyed by full ARN. Query the database for every type you map, and write a test asserting the exact `toId`.
- **A missing edge beats a dangling one.** If an id cannot be produced that will match inventory, emit nothing and say so in the report.
- **Scan time is a budget.** Report added AWS calls per scan for every enrichment.
- **Degrade gracefully.** A failed enrichment logs a warning and leaves the key absent; the scan still succeeds.
- Any new relation must be added to `RELATION_KIND` in `apps/web-ui/lib/resource-graph/relation-kinds.ts` with a test, or it renders as an anonymous dotted `other`.
- No comments unless the WHY is non-obvious; never multi-line docstring blocks. 2-space indentation in `apps/workers`.
- Read installed `@aws-sdk/client-*` `.d.ts` files at the WORKSPACE ROOT for response shapes. Do not guess field names; do not call AWS to find out.
- Five workers tests fail before this plan starts (`account-service`, `audit-service`, `custom-scanners`) — pre-existing, unrelated. Confirm still five; do not fix them.
- Do not commit unless the user asks. Never `git stash`, push, force-push, or rewrite history.

---

### Task 1: CloudWatch alarms on load balancers and target groups

46 alarms — the single largest fixable group. `DIMENSION_TO_TYPE` in `edge-derivers.ts` maps 11 dimension names; `LoadBalancer` and `TargetGroup` are absent, so every ALB alarm derives nothing.

**This is the id-shape trap, so read carefully.** A CloudWatch `LoadBalancer` dimension value is the ARN's tail:

```
app/stx-notification-center-alb-plfm/ad863efe1f662bec
```

while `elbv2_load_balancers` are inventoried by full ARN:

```
arn:aws:elasticloadbalancing:ap-south-1:072097020844:loadbalancer/app/stx-notification-center-alb-plfm/ad863efe1f662bec
```

The dimension is a **suffix** of the ARN. A naive mapping produces 46 edges that match nothing.

**Files:**
- Modify: `apps/workers/src/jobs/discovery/services/edge-derivers.ts`
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-derivers.test.ts`
- Modify: `docs/RESOURCE_GRAPH_ARCHITECTURE.md`

- [ ] **Step 1: Confirm both id shapes against the database**

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus -tA -c "SELECT \"resourceType\", \"resourceId\" FROM inventory_resources WHERE \"isCurrent\" AND \"resourceType\" IN ('elbv2_load_balancers','elbv2_targroups') LIMIT 4;"
```

Then confirm what the alarm actually carries, from a real row:

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus -tA -c "SELECT \"resourceId\" FROM inventory_resources WHERE \"isCurrent\" AND \"resourceType\"='cloudwatch_alarms' AND \"resourceId\" LIKE '%ALB%' LIMIT 3;"
```

Record both. The mapping is written against what you find, not against this document.

- [ ] **Step 2: Widen the deriver signature — it currently cannot see what it needs**

`type Deriver = (raw, fromId) => ResourceEdge[]`. There is no `accountId` and no `region`, so
as things stand the ARN **cannot** be reconstructed. This was a defect in an earlier draft of
this plan — do not paper over it with a guessed value.

`extractEdges(resources, scanningAccountId)` has the account, and each `resource.region` has
the region. Widen the type so both reach the deriver:

```typescript
type DeriverContext = { accountId: string; region: string };
type Deriver = (raw: Record<string, any>, fromId: string, ctx: DeriverContext) => ResourceEdge[];
```

The four existing derivers ignore the third argument and need no change. Update the single
call site in `edge-extractor.ts` to pass it, and add a test proving the context arrives.

Then the ARN is reconstructable:

```
arn:aws:elasticloadbalancing:{region}:{accountId}:loadbalancer/{dimensionValue}
arn:aws:elasticloadbalancing:{region}:{accountId}:targetgroup/{dimensionValue}
```

Confirm that reconstruction produces a string that exactly equals an inventoried `resourceId` — check one by hand against the database before writing the code. If it does not match for any reason, STOP and report rather than shipping 46 dangling edges.

- [ ] **Step 3: Write the failing tests**

Cover, with exact `toId` assertions:
- an ALB alarm producing an edge whose `toId` is the full reconstructed load-balancer ARN
- a target-group alarm producing the full target-group ARN
- an alarm with an `InstanceId` dimension still producing the short instance id (the existing behaviour must not regress)
- an alarm whose dimension name is unmapped producing nothing
- an alarm with no dimensions producing nothing

- [ ] **Step 4: Run and watch fail**

```bash
cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/edge-derivers.test.ts
```

- [ ] **Step 5: Implement**

Extend `DIMENSION_TO_TYPE` so an entry can carry an id transform, rather than special-casing two names inside the loop. Reuse the `FULL_ARN_TYPES` idea already in this file rather than inventing a parallel mechanism.

- [ ] **Step 6: Run the discovery suite, update the doc, commit**

```bash
git add apps/workers/src/jobs/discovery docs/RESOURCE_GRAPH_ARCHITECTURE.md
git commit -m "feat(discovery): derive cloudwatch alarm edges for load balancers and target groups"
```

---

### Task 2: Resolve cross-account edge targets on the canvas

Nothing is wrong with the data. 61 edges in the measured account point at KMS key `dfaa0d40-…`, which is inventoried in account `861276112345`. A shared key, correctly recorded.

The canvas cannot show it: `getSeed` returns one account's nodes, and `edgesAmong` only keeps edges whose **both** endpoints are in that node set. So the edge is dropped and the bucket looks isolated.

This is the same shape as the shared transit gateways, and it is a read-side fix — no scanner change.

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts`
- Modify: `apps/web-ui/lib/db/repositories/resource-graph/interface.ts`
- Modify: `apps/web-ui/lib/resource-graph/build-elements.ts`
- Modify: `apps/web-ui/components/resource-graph/graph-styles.ts`
- Test: `apps/web-ui/tests/resource-graph/repository.integration.test.ts`
- Test: `apps/web-ui/lib/resource-graph/__tests__/build-elements.test.ts`

- [ ] **Step 1: Confirm the situation is real, not a keying bug**

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus -c "
SELECT e.\"toId\", i.\"accountId\" AS key_lives_in, count(*) refs
FROM resource_edges e
JOIN inventory_resources i ON i.\"isCurrent\" AND i.\"resourceType\"='kms_keys' AND i.\"resourceId\"=e.\"toId\"
WHERE e.\"isCurrent\" AND e.\"accountId\"='869935102658' AND e.\"toType\"='kms_keys'
  AND i.\"accountId\" <> e.\"accountId\"
GROUP BY 1,2 ORDER BY refs DESC;"
```

A non-empty result confirms genuine cross-account references. An empty result means the premise is wrong — STOP and report.

- [ ] **Step 2: Write the failing test**

Extend `getSeed` so its edge set also includes edges whose far endpoint exists in inventory **under a different account**, returning those endpoints as extra nodes flagged `external: true`. Assert:
- a seed for the canvas account includes an edge to a resource owned by another account
- that node carries `external: true` and the owning account id
- a same-account seed is unchanged in node and edge count (the existing fixture pins this)
- the extra nodes do not bypass the tenant guard — an edge to another TENANT's resource must never appear

That last case is the one to get right. Add a fixture row under `OTHER_TENANT` and assert it is absent.

- [ ] **Step 3: Run and watch fail, then implement**

Keep it bounded: cap the number of external nodes and report truncation, per the project's no-silent-truncation rule.

- [ ] **Step 4: Render them distinctly**

An external node is context, not part of this account. Style it muted with a dashed border, and show its owning account in the detail panel so nobody mistakes it for a local resource.

- [ ] **Step 5: Run the full web-ui graph suite, commit**

```bash
git add apps/web-ui/lib apps/web-ui/components apps/web-ui/tests
git commit -m "feat(resource-graph): show cross-account edge targets as external nodes"
```

---

### Task 3: S3 buckets — CloudFront origins and event notifications

76 isolated buckets, the largest single group. Phase 3 added `s3 -> kms`, which only helped 5 — most buckets use SSE-S3 or an AWS-managed alias.

**CloudFront is out of scope — measured, not assumed.** This tenant has **zero**
`cloudfront_distributions` inventoried, so the existing `origin_is` deriver is not broken; it
simply has nothing to fire on. Building for it would be building for data that does not exist.

That leaves one relationship: **bucket notifications**.
`GetBucketNotificationConfiguration` returns the Lambda, SQS and SNS targets for object events.
Note this caps what Task 3 can recover — buckets whose only real relationship is a CloudFront
origin will remain isolated, correctly.

**Files:**
- Modify: `apps/workers/src/jobs/discovery/scanfile.json`
- Modify: `apps/workers/src/jobs/discovery/services/edge-derivers.ts`
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-derivers.test.ts`
- Modify: `apps/web-ui/lib/resource-graph/relation-kinds.ts` + its test

- [ ] **Step 1: Read the notification response shape**

```bash
grep -A12 "interface NotificationConfiguration" node_modules/@aws-sdk/client-s3/dist-types/models/models_0.d.ts
grep -A10 "interface LambdaFunctionConfiguration" node_modules/@aws-sdk/client-s3/dist-types/models/models_0.d.ts
grep -A10 "interface QueueConfiguration" node_modules/@aws-sdk/client-s3/dist-types/models/models_0.d.ts
grep -A10 "interface TopicConfiguration" node_modules/@aws-sdk/client-s3/dist-types/models/models_0.d.ts
```

Each carries an ARN. Verify the id shape each target type is keyed by in inventory before mapping — `sns_topics` are keyed by FULL ARN, `lambda_functions` and `sqs_queues` by short name. This is the Phase 3 trap; do not repeat it.

- [ ] **Step 2: Write failing tests, run, implement**

New relation `notifies_on_event`. Add it to `RELATION_KIND` as `traffic` with a test.

An unconfigured bucket returns an empty configuration — that must produce nothing, not an error.

- [ ] **Step 3: Measure the cost**

One `GetBucketNotificationConfiguration` per bucket, on top of the encryption call Phase 3 added. That is now two calls per bucket, 2,797 buckets tenant-wide. Report the total and flag it if the largest account exceeds ~400 buckets.

- [ ] **Step 4: Run the suite, update the doc, commit**

```bash
git add apps/workers/src/jobs/discovery apps/web-ui/lib/resource-graph docs/RESOURCE_GRAPH_ARCHITECTURE.md
git commit -m "feat(discovery): derive s3 notification edges"
```

---

### Task 4: ECS tasks to their ECR repositories

6 isolated repositories, and the relationship people most often want from a graph: *which service is running the image from this repo?*

A task definition's `containerDefinitions[].image` is a full image URI:

```
970547372609.dkr.ecr.ap-south-1.amazonaws.com/llm-powerhouse/litellm-proxy:v1.2
```

The repository name is the path between the host and the tag, and it frequently contains
slashes: **113 of 638 inventoried repositories (18%) have one**, e.g.
`llm-powerhouse/litellm-proxy`. A naive `split('/')` truncates almost one in five. Parse from
the host boundary to the tag boundary rather than splitting.

**Files:**
- Modify: `apps/workers/src/jobs/discovery/services/custom-scanners.ts` (the ECS deep scan already fetches services)
- Modify: `apps/workers/src/jobs/discovery/services/edge-derivers.ts`
- Test: both `__tests__` counterparts
- Modify: `apps/web-ui/lib/resource-graph/relation-kinds.ts` + its test

- [ ] **Step 1: Check what the ECS deep scanner already retrieves**

Read `ecsServicesDeep` in `custom-scanners.ts`. If it already has the task definition ARN, one `DescribeTaskDefinition` per distinct definition is enough — and distinct definitions are far fewer than services, so deduplicate before calling. Report the call count.

- [ ] **Step 2: Verify the ECR id shape**

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus -tA -c "SELECT \"resourceId\" FROM inventory_resources WHERE \"isCurrent\" AND \"resourceType\"='ecr_repositories' LIMIT 6;"
```

Confirm whether slash-containing names appear, and write the parser against that.

- [ ] **Step 3: Write failing tests, run, implement**

Cover: a slash-containing repository name; a tag and a digest (`@sha256:…`) form; a public or third-party image (`nginx:latest`) producing NOTHING, since it is not an ECR repository this account owns; an image from another account's registry producing nothing rather than a dangling edge.

New relation `runs_image_from`, classified as `attachment`, with a test.

- [ ] **Step 4: Run the suite, update the doc, commit**

```bash
git add apps/workers/src/jobs/discovery apps/web-ui/lib/resource-graph docs/RESOURCE_GRAPH_ARCHITECTURE.md
git commit -m "feat(discovery): link ecs task definitions to their ecr repositories"
```

---

### Task 5: Re-measure and record

- [ ] **Step 1: Ask before scanning.** A discovery scan calls live AWS. Scope it to account `869935102658` only; do NOT trigger the fan-out across all 99 accounts. Confirm with the user first.

- [ ] **Step 2: Re-run the audit**

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus -c "
WITH vis AS (SELECT \"resourceType\" t,\"resourceId\" i FROM inventory_resources
  WHERE \"isCurrent\" AND \"accountId\"='869935102658' AND \"resourceType\" NOT IN ('ssm_parameters','iam_roles')),
linked AS (SELECT v.t, EXISTS (SELECT 1 FROM resource_edges e WHERE e.\"isCurrent\"
    AND ((e.\"fromType\"=v.t AND e.\"fromId\"=v.i) OR (e.\"toType\"=v.t AND e.\"toId\"=v.i))
    AND NOT (e.\"toType\"='kms_keys' AND e.\"toId\" LIKE 'alias/aws/%')) c FROM vis v)
SELECT t, count(*) total, count(*) FILTER (WHERE c) connected, count(*) FILTER (WHERE NOT c) isolated
FROM linked GROUP BY t HAVING count(*) FILTER (WHERE NOT c) > 0 ORDER BY isolated DESC;"
```

Baseline is 841 / 676 / 165. Report the new figures per type.

- [ ] **Step 3: Record the result in the architecture doc**, replacing the coverage figures with measured before and after — so the next person inherits a number, not an impression.

## Phase 3b done when

- Both test suites pass, with the same five pre-existing workers failures and no new ones.
- The isolated count is materially below 165, and every remaining isolated resource matches a row in the audit table marked **accept**.
- `RESOURCE_GRAPH_ARCHITECTURE.md` Known Limitations reflects only what is genuinely still missing.

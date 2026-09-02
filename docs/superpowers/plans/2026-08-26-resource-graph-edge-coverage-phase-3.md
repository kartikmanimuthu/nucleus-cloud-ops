# Resource Graph Edge Coverage — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the share of discovered resources that have any relationship at all. Measured on account `869935102658`: 305 of 821 visible resources are connected, 516 are not — and most of those 516 are connected in AWS, we simply never extract their edges.

**Architecture:** Extend the existing deterministic extraction — `scanfile.json` enrichments feed `rawData`, `EDGE_SPECS` and `CUSTOM_DERIVERS` turn that into `resource_edges`. No new tables, no new services, no LLM.

**Tech Stack:** TypeScript, AWS SDK v3, pg-boss workers, Vitest.

**Spec:** none — this extends `docs/RESOURCE_GRAPH_ARCHITECTURE.md`, whose "Known Limitations" section names most of these gaps. Update that section as each is closed.

## Measured baseline (2026-08-26, account 869935102658)

| | |
| --- | --- |
| Visible resources | 821 |
| Connected to something | 305 |
| Isolated | 516 |

Isolated by type: `s3_buckets` 139, `codepipeline_pipelines` 61, `cloudwatch_alarms` 46, `events_rules` 29, `kms_keys` 11, `ecr_repositories` 6, `ec2_addresses` 6.

Verified causes, not assumed:
- `s3_buckets`, `codepipeline_pipelines`, `events_rules`, `ec2_addresses` have **no entry in `EDGE_SPECS` at all**.
- The 46 `cloudwatch_alarms` are not isolated: 186 `monitors` + 57 `notifies` edges exist for this account already, hidden by the default observation filter.
- `ec2_addresses` additionally carry the wrong id — see Task 1.

## Global Constraints

- **Deterministic only.** Edges come from describe responses. No LLM, no inference, no heuristics that guess a relationship.
- **An edge must be real.** If a response does not contain the far side's identifier, emit nothing. A missing edge is honest; an invented one is a defect.
- **Scan time is a budget.** Every enrichment adds an AWS call per resource. Each task that adds one must measure and report the added call count, and use batching or a cap where the API allows.
- **Degrade gracefully.** A failed enrichment logs a warning and leaves `rawData` without that key — the scan must still succeed, matching how target-group scanning already behaves.
- No comments unless the WHY is non-obvious; never multi-line docstring blocks.
- 2-space indentation in `apps/workers`.
- Do not commit unless the user asks. Never `git stash`, push, force-push, or rewrite history.
- Read the installed `@aws-sdk/client-*` `.d.ts` files for response shapes. Do not guess field names, and do not call AWS to find out.

---

### Task 1: Elastic IPs get their own identity, and their edges

`extractResourceIdentifiers` picks a resource id from an ordered `idKeys` list at `apps/workers/src/jobs/discovery/services/scanner.ts:443`. `AllocationId` is absent from that list and `InstanceId` is first, so an Elastic IP attached to an instance is stored under **the instance's id** — it collides with the instance's own row and can never be referenced as an EIP. This is the documented `ec2_addresses` exclusion in `RESOURCE_GRAPH_ARCHITECTURE.md`.

**Files:**
- Modify: `apps/workers/src/jobs/discovery/services/scanner.ts:443`
- Modify: `apps/workers/src/jobs/discovery/services/edge-spec.ts`
- Modify: `docs/RESOURCE_GRAPH_ARCHITECTURE.md` (remove the EIP limitation)
- Test: `apps/workers/src/jobs/discovery/__tests__/scanner.test.ts`
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-extractor.test.ts`

- [ ] **Step 1: Confirm the field names against the SDK, not from memory**

```bash
grep -B2 -A12 "export interface Address {" node_modules/@aws-sdk/client-ec2/dist-types/models/models_0.d.ts | head -40
```

Record which of `AllocationId`, `InstanceId`, `NetworkInterfaceId`, `PublicIp`, `AssociationId` exist on `Address`. Those names drive both steps below.

- [ ] **Step 2: Write the failing tests**

In `scanner.test.ts`, add to the `extractResourceIdentifiers` describe block:

```typescript
    it('identifies an elastic ip by its allocation id, not the instance it is attached to', () => {
        const ids = extractResourceIdentifiers({
            AllocationId: 'eipalloc-1',
            InstanceId: 'i-999',
            PublicIp: '52.1.2.3',
        });
        expect(ids.resourceId).toBe('eipalloc-1');
    });

    it('still identifies an instance by its instance id', () => {
        expect(extractResourceIdentifiers({ InstanceId: 'i-999' }).resourceId).toBe('i-999');
    });
```

In `edge-extractor.test.ts`:

```typescript
    it('links an attached elastic ip to its instance and interface', () => {
        const edges = extractEdges([
            r('ec2_addresses', 'eipalloc-1', {
                AllocationId: 'eipalloc-1',
                InstanceId: 'i-1',
                NetworkInterfaceId: 'eni-1',
            }),
        ], '111111111111');

        expect(edges).toContainEqual(expect.objectContaining({
            fromType: 'ec2_addresses', fromId: 'eipalloc-1',
            relation: 'attached_to', toType: 'ec2_instances', toId: 'i-1',
        }));
        expect(edges.some((e) => e.toType === 'ec2_network_interfaces' && e.toId === 'eni-1')).toBe(true);
    });

    it('emits no edges for an unattached elastic ip', () => {
        const edges = extractEdges([
            r('ec2_addresses', 'eipalloc-2', { AllocationId: 'eipalloc-2', PublicIp: '52.1.2.3' }),
        ], '111111111111');

        expect(edges).toHaveLength(0);
    });
```

- [ ] **Step 3: Run them and watch them fail**

```bash
cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/scanner.test.ts src/jobs/discovery/__tests__/edge-extractor.test.ts
```

- [ ] **Step 4: Fix the identifier**

In `scanner.ts`, put `AllocationId` at the front of `idKeys`, with the reason:

```typescript
  const idKeys = [
    // AllocationId first: an attached Elastic IP's describe_addresses response carries the
    // instance's InstanceId as a context field, so matching InstanceId first files the EIP
    // under the instance's own id. Only EIP responses carry a top-level AllocationId, so
    // hoisting it cannot affect any other resource type.
    'AllocationId',
    'InstanceId', 'DBInstanceIdentifier', 'DBClusterIdentifier', 'ClusterIdentifier',
```

Leave the rest of the list untouched.

- [ ] **Step 5: Add the edge rules**

In `edge-spec.ts`, add a new entry beside the other `ec2_` blocks:

```typescript
    ec2_addresses: [
        { path: 'InstanceId', relation: 'attached_to', toType: 'ec2_instances' },
        { path: 'NetworkInterfaceId', relation: 'attached_to', toType: 'ec2_network_interfaces' },
    ],
```

Both fields are absent on an unattached EIP, and `extractEdges` already skips a spec whose path resolves to nothing — which is what the second test pins.

- [ ] **Step 6: Run the whole discovery suite**

```bash
cd apps/workers && bunx vitest run src/jobs/discovery
```

Five failures in `account-service`, `audit-service` and `custom-scanners` are pre-existing on this branch and unrelated — confirm the count is still five and that none of them are new.

- [ ] **Step 7: Update the architecture doc**

Remove the `ec2_addresses` bullet from "Known Limitations" in `docs/RESOURCE_GRAPH_ARCHITECTURE.md` and note that EIPs are now keyed on `AllocationId`.

- [ ] **Step 8: Commit**

```bash
git add apps/workers/src/jobs/discovery docs/RESOURCE_GRAPH_ARCHITECTURE.md
git commit -m "fix(discovery): key elastic ips on AllocationId and link them to their instance"
```

---

### Task 2: Show the relationships we already have

The 46 `cloudwatch_alarms` rendering as isolated are not isolated: **186 `monitors` and 57 `notifies` edges exist for that one account**. They are hidden because `observation` is off by default in both the repository filters and the canvas stylesheet.

That default was set when the graph was a dense per-account canvas and alarm edges were noise. On a graph whose problem is emptiness, hiding 243 real edges is the wrong trade.

**Files:**
- Modify: `apps/web-ui/lib/resource-graph/graph-constants.ts`
- Modify: `apps/web-ui/components/resource-graph/graph-styles.ts`
- Test: `apps/web-ui/tests/resource-graph/filter-sql.test.ts` (the default is asserted at line 13, NOT in graph-constants.test.ts)
- Test: `apps/web-ui/components/resource-graph/__tests__/graph-styles.test.ts`
- Modify: `docs/superpowers/specs/2026-08-25-tenant-resource-graph-design.md` (D3 pins this default)

- [ ] **Step 1: Decide the surface, then write the failing test**

`includeObservation` stays in `GraphFilters` so a caller can still exclude alarm edges; only the DEFAULT flips.

The existing assertion lives at `apps/web-ui/tests/resource-graph/filter-sql.test.ts:13`
("excludes observation relations by default and includes them on request") and must be
rewritten, not left to fail. Phase 1's spec decision D3 also pins this default, so update
that document in the same commit — a spec that contradicts the code is worse than no spec.

```typescript
    it('includes observation edges by default so alarm relationships are visible', () => {
        expect(edgeFilterSql('e', {})).not.toContain('monitors');
        expect(edgeFilterSql('e', { includeObservation: false })).toContain('monitors');
    });
```

This inverts the flag's meaning, so `edgeFilterSql` must be changed from `if (!filters.includeObservation)` to `if (filters.includeObservation === false)`. Check every call site for callers relying on the old default — `findPath` passes `includeObservation: true` explicitly and is unaffected.

- [ ] **Step 2: Run and watch fail**

```bash
cd apps/web-ui && bunx vitest run lib/resource-graph/ tests/resource-graph/filter-sql.test.ts
```

- [ ] **Step 3: Flip the default in the filter builder and the stylesheet**

In `graph-styles.ts`, the `edge[relationKind = "observation"]` rule currently sets `display: 'none'`. Replace it with a visible-but-quiet treatment, so alarms read as annotation rather than structure:

```typescript
    {
      selector: 'edge[relationKind = "observation"]',
      style: {
        width: 1,
        'line-style': 'dashed',
        'line-dash-pattern': [2, 5],
        'line-opacity': 0.35,
        'target-arrow-shape': 'none',
        label: '',
      },
    },
```

- [ ] **Step 4: Run the full graph test set**

```bash
cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' bunx vitest run tests/resource-graph/ lib/resource-graph/ components/resource-graph/
```

- [ ] **Step 5: Verify the effect against real data**

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus -c "SELECT count(DISTINCT \"fromId\") alarms, count(*) edges FROM resource_edges WHERE \"isCurrent\" AND \"accountId\"='869935102658' AND relation IN ('monitors','notifies');"
```

Expected: 46 alarms across 243 edges now joining the graph. Report the numbers.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/resource-graph apps/web-ui/components/resource-graph
git commit -m "feat(resource-graph): show alarm relationships by default"
```

---

### Task 3: EventBridge rules reach their targets

`events list_rules` is scanned with no enrichment, so a rule's targets — the Lambda, queue, topic or ECS task it fires — never reach `rawData`. 29 rules sit isolated in the measured account.

**Files:**
- Modify: `apps/workers/src/jobs/discovery/scanfile.json`
- Modify: `apps/workers/src/jobs/discovery/services/edge-derivers.ts`
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-derivers.test.ts`

- [ ] **Step 1: Read the real shapes**

```bash
grep -A8 "interface ListTargetsByRuleResponse" node_modules/@aws-sdk/client-eventbridge/dist-types/models/models_0.d.ts
grep -A20 "^export interface Target {" node_modules/@aws-sdk/client-eventbridge/dist-types/models/models_0.d.ts
```

Confirm the response key is `Targets` and each target's ARN field is `Arn`. Record what the request requires (`Rule`, and `EventBusName` for non-default buses) — a rule on a custom bus needs the bus name or the call returns nothing.

- [ ] **Step 2: Check the enrichment runner supports this shape**

Read `apps/workers/src/jobs/discovery/services/scanner.ts` where `EnrichmentStep` is applied. Establish which of `tags` / `describe` / `detail` fits a per-resource call keyed on `Name` returning a list, and whether `resultKey` can merge `Targets` onto the rule object. If none of the three fit, STOP and report — adding a fourth enrichment type is a design change, not part of this task.

- [ ] **Step 3: Write the failing deriver test**

The target ARN identifies the service and the resource, so the deriver maps ARN service → resource type. Add to `edge-derivers.test.ts`:

```typescript
describe('eventsRules deriver', () => {
    const derive = (raw: Record<string, unknown>) => CUSTOM_DERIVERS.events_rules(raw, 'my-rule');

    it('links a rule to a lambda target', () => {
        const edges = derive({ _targets: [{ Arn: 'arn:aws:lambda:ap-south-1:111:function:my-fn' }] });
        expect(edges).toContainEqual(expect.objectContaining({
            relation: 'triggers', toType: 'lambda_functions', toId: 'my-fn',
        }));
    });

    it('links a rule to sqs and sns targets', () => {
        const edges = derive({ _targets: [
            { Arn: 'arn:aws:sqs:ap-south-1:111:my-queue' },
            { Arn: 'arn:aws:sns:ap-south-1:111:my-topic' },
        ] });
        expect(edges.map((e) => e.toType).sort()).toEqual(['sns_topics', 'sqs_queues']);
    });

    it('emits nothing for a target whose service has no inventory type', () => {
        expect(derive({ _targets: [{ Arn: 'arn:aws:states:ap-south-1:111:stateMachine:sm' }] })).toHaveLength(0);
    });

    it('emits nothing when the enrichment failed and no targets key exists', () => {
        expect(derive({})).toHaveLength(0);
    });
});
```

- [ ] **Step 4: Run and watch fail**
- [ ] **Step 5: Add the enrichment to `scanfile.json` and the deriver to `edge-derivers.ts`**

The deriver parses the ARN's service segment and maps only services this scanner actually
inventories — an unmapped service emits nothing rather than a dangling edge to a type that
will never exist.

**Also classify the new relation.** `triggers` is not in `RELATION_KIND` in
`apps/web-ui/lib/resource-graph/relation-kinds.ts`, so `kindOf` returns `other` and the edge
renders as an anonymous dotted line. Add `triggers: 'traffic'` — a rule firing a Lambda is
flow, not attachment — and add a case to `relation-kinds.test.ts`. The same applies to every
new relation introduced in Task 5.

- [ ] **Step 6: Measure the cost**

`ListTargetsByRule` is one call per rule and is not batchable. Count the rules in the measured account:

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus -tA -c "SELECT count(*) FROM inventory_resources WHERE \"isCurrent\" AND \"resourceType\"='events_rules';"
```

Report the number and the added calls per scan. If it exceeds roughly 500 per account, report before proceeding — the scan already fans out across 99 accounts.

- [ ] **Step 7: Run the discovery suite, update the architecture doc's Known Limitations, commit**

```bash
git add apps/workers/src/jobs/discovery docs/RESOURCE_GRAPH_ARCHITECTURE.md
git commit -m "feat(discovery): derive eventbridge rule target edges"
```

---

### Task 4: S3 buckets reach their KMS keys

139 isolated buckets in the measured account. `list_buckets` returns only `Name` and `CreationDate`; the bucket's default encryption key needs `GetBucketEncryption`.

**Files:**
- Modify: `apps/workers/src/jobs/discovery/scanfile.json`
- Modify: `apps/workers/src/jobs/discovery/services/edge-spec.ts`
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-spec.test.ts`

- [ ] **Step 1: Read the real shape**

```bash
grep -A10 "interface GetBucketEncryptionOutput" node_modules/@aws-sdk/client-s3/dist-types/models/models_0.d.ts
grep -A10 "interface ServerSideEncryptionRule" node_modules/@aws-sdk/client-s3/dist-types/models/models_0.d.ts
```

Confirm the path to the key id — expected
`ServerSideEncryptionConfiguration.Rules[].ApplyServerSideEncryptionByDefault.KMSMasterKeyID`.

- [ ] **Step 2: Write the failing spec test**

An `EDGE_SPECS` entry suffices; no custom deriver. Assert the path resolves, the ARN transform yields the key id, and that an `AES256` bucket (SSE-S3, no KMS key) emits nothing.

- [ ] **Step 3: Run and watch fail**
- [ ] **Step 4: Add the enrichment and the spec entry**

```typescript
    s3_buckets: [
        { path: '_encryption.ServerSideEncryptionConfiguration.Rules[].ApplyServerSideEncryptionByDefault.KMSMasterKeyID',
          relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
    ],
```

Note the default-filter interaction: a bucket encrypted with an AWS-managed alias produces an edge that the display filter hides, so it will still look isolated on the canvas. That is correct behaviour and worth stating in the report rather than being surprised by it later.

- [ ] **Step 5: Measure the cost**

One call per bucket, not batchable, and `GetBucketEncryption` throws `ServerSideEncryptionConfigurationNotFoundError` for unencrypted buckets — that must be caught and treated as "no key", not as a scan failure. Report the bucket count per account.

- [ ] **Step 6: Run the suite, update the doc, commit**

```bash
git add apps/workers/src/jobs/discovery docs/RESOURCE_GRAPH_ARCHITECTURE.md
git commit -m "feat(discovery): derive s3 bucket encryption edges"
```

---

### Task 5: CodePipeline reaches its sources and targets

61 isolated pipelines in the measured account, and the richest remaining relationships: a pipeline links a source repository, an artifact bucket, and deploy targets such as ECS services or Lambda functions.

**Files:**
- Modify: `apps/workers/src/jobs/discovery/scanfile.json`
- Modify: `apps/workers/src/jobs/discovery/services/edge-derivers.ts`
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-derivers.test.ts`

- [ ] **Step 1: Read the real shape**

```bash
grep -A12 "interface GetPipelineOutput" node_modules/@aws-sdk/client-codepipeline/dist-types/models/models_0.d.ts
grep -A25 "^export interface PipelineDeclaration {" node_modules/@aws-sdk/client-codepipeline/dist-types/models/models_0.d.ts
grep -A25 "^export interface ActionDeclaration {" node_modules/@aws-sdk/client-codepipeline/dist-types/models/models_0.d.ts
```

The identifiers live in `stages[].actions[].configuration`, a free-form `Record<string, string>` whose keys depend on the action provider — `ClusterName`/`ServiceName` for ECS deploy, `FunctionName` for Lambda, `BucketName` for S3, `RepositoryName` for CodeCommit. Write down the exact provider names before coding; this is the task most likely to be built on a guess.

- [ ] **Step 2: Write the failing deriver tests**

Cover, at minimum: an ECS deploy action producing an `ecs_services` edge; an S3 source producing an `s3_buckets` edge; an action whose provider is unrecognised producing nothing; and a pipeline whose enrichment failed producing nothing.

- [ ] **Step 3: Run and watch fail**
- [ ] **Step 4: Add the enrichment and the deriver**

Key the mapping on `actionTypeId.provider`, not on configuration key names alone — two providers can share a key name and the provider is what makes the mapping unambiguous.

- [ ] **Step 5: Measure the cost and commit**

One `GetPipeline` per pipeline. Report the count.

```bash
git add apps/workers/src/jobs/discovery docs/RESOURCE_GRAPH_ARCHITECTURE.md
git commit -m "feat(discovery): derive codepipeline source and deploy edges"
```

---

### Task 6: Re-measure and report

The point of this phase is a number. Establish whether it moved.

- [ ] **Step 1: Run a real discovery scan — ONE account, and ask first**

A discovery scan calls live AWS APIs. The scheduled job fans out across all 99 accounts, and
the enrichments added in Tasks 3-5 multiply the call count per account. Do NOT trigger the
fan-out.

Scope the run to account `869935102658` only, and confirm with the user before running it —
this is the first step in the plan that reaches outside the repository. If that confirmation
is not available, stop here and report; the code changes are still verifiable by their unit
tests, and the measurement can be taken later.

This run is also what finally populates `toAccountId` from the Phase 1 fix, which has never
executed against real data.

- [ ] **Step 2: Re-run the baseline query**

```bash
docker exec nucleus-postgres psql -U nucleus -d nucleus -c "
WITH vis AS (
  SELECT \"resourceType\", \"resourceId\" FROM inventory_resources
  WHERE \"isCurrent\" AND \"accountId\"='869935102658'
    AND \"resourceType\" NOT IN ('ssm_parameters','iam_roles')),
linked AS (
  SELECT DISTINCT v.* FROM vis v WHERE EXISTS (
    SELECT 1 FROM resource_edges e WHERE e.\"isCurrent\"
      AND ((e.\"fromType\"=v.\"resourceType\" AND e.\"fromId\"=v.\"resourceId\")
        OR (e.\"toType\"=v.\"resourceType\" AND e.\"toId\"=v.\"resourceId\"))))
SELECT (SELECT count(*) FROM vis) total,
       (SELECT count(*) FROM linked) connected,
       (SELECT count(*) FROM vis)-(SELECT count(*) FROM linked) isolated;"
```

Baseline was 821 / 305 / 516. Report the new figures and the remaining isolated types.

- [ ] **Step 3: Record the result in the architecture doc**

Replace the Coverage section's figures with the measured before and after, so the next person inherits a number rather than an impression.

## Phase 3 done when

- Both discovery and web-ui test suites pass, with the same five pre-existing workers failures and no new ones.
- The isolated count for account `869935102658` is materially below 516, and the remaining isolated resources are ones with genuinely no relationships — which stay visible on the canvas, because an orphan is a finding.
- `docs/RESOURCE_GRAPH_ARCHITECTURE.md` Known Limitations reflects what is actually still missing.

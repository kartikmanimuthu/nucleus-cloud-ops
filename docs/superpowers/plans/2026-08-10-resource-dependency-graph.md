# Resource Dependency Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AI Ops agent a traversable dependency graph of discovered AWS resources, so it can answer blast-radius and root-cause questions that a flat inventory table cannot.

**Architecture:** One new Postgres table (`resource_edges`) holding `(fromType, fromId, relation, toType, toId)` rows. Edges are extracted **inside the discovery scan** from the raw AWS describe-API responses (which already contain every relationship) via a declarative spec table, and written alongresources with the same per-scan `isCurrent` lifecycle. The web-ui side exposes traversal through a repository backed by Postgres recursive CTEs, surfaced to the agent as two read-only LangChain tools. No graph database, no LLM extraction, no new UI.

**Tech Stack:** PostgreSQL 16 + Prisma 5/6 (dual client), pg-boss workers (TypeScript, raw `pg` writes), LangChain/LangGraph tools, Vitest.

## Global Constraints

- **`rawData` is never persisted.** [pg-writer.ts:52](../../../apps/workers/src/jobs/discovery/services/pg-writer.ts) runs `extractMetadata()` and stores only the filtered result. Edge extraction MUST happen during the scan, while `rawData` is in memory. There is nothing in the database to backfill from.
- **Manual tenant scoping.** Worker writes use raw `pg` (`client.query`). Web-ui traversal uses `$queryRawUnsafe`, which per `CLAUDE.md` is **not** intercepted by the Prisma tenant extension. Every edge query — read and write — must carry an explicit `"tenantId" = $n` predicate.
- **No foreign key from `resource_edges` to `inventory_resources`.** Edge targets routinely do not exist as rows (unscanned region, failed scanner, cross-account VPC peer). Dangling edges must be inert data, not insert failures.
- **`toId` must match the target type's `resourceId` convention** as produced by `extractResourceIdentifiers` ([scanner.ts:431](../../../apps/workers/src/jobs/discovery/services/scanner.ts)). These conventions are inconsistent across types (some full ARN, some bare name); the per-type table in Task 4 is authoritative.
- **Resource type naming** is `${service}_${function}` with the first `describe_`/`list_`/`get_` prefix stripped ([scanner.ts:562](../../../apps/workers/src/jobs/discovery/services/scanner.ts)).
- **Workers logging:** `createLogger('name')` from `apps/workers/src/lib/logger.ts`. Never raw `console`.
- **Repository pattern:** web-ui data access goes through `@/lib/db/repository-factory`. API routes and agent tools never touch Prisma directly.
- **Agent tools are tenant-bound at construction** — never accept a `tenantId` from the model. Follow `createGetRightSizingRecommendationsTool` ([right-sizing-tool.ts:12](../../../apps/web-ui/lib/agent/right-sizing-tool.ts)).
- **Migration naming:** `libs/prisma/migrations/<YYYYMMDDHHMMSS>_<snake_name>/migration.sql`.
- Prisma clients are dual-generated. After schema changes run `db:generate` in **both** `apps/web-ui` and `apps/workers`.

## Known Pre-Existing Issues (flag, do not fix)

These are pre-existing defects in `extractResourceIdentifiers` discovered while mapping ID conventions. They constrain this feature. Do **not** refactor them as part of this work.

1. **`ec2_addresses` (Elastic IPs) get the wrong `resourceId`.** `InstanceId` is checked first in `idKeys`, so an EIP attached to an instance is stored with the *instance's* ID. Consequence: `ec2_addresses` is excluded from the edge spec entirely (Task 4), since edges pointing at it would target corrupt IDs.
2. **`wafv2_web_acls` `resourceId` is the ACL *name*** (`Name` matches early in `idKeys`), but CloudFront reports `WebACLId` as a full ARN whose last segment is the ACL *ID*, not the name. Consequence: the `cloudfront → waf` edge is omitted (Task 5).

---

## File Structure

| File | Responsibility |
|---|---|
`libs/prisma/schema.prisma` (modify) | `ResourceEdge` model |
`libs/prisma/migrations/20260810120000_add_resource_edges/migration.sql` (create) | Table + indexes |
`apps/workers/src/jobs/discovery/types.ts` (modify) | `ResourceEdge`, `EdgeSpec` types |
`apps/workers/src/jobs/discovery/services/scanner.ts` (modify) | Add `TargetGroupArn` to `idKeys`/`nameKeys` |
`apps/workers/src/jobs/discovery/scanfile.json` (modify) | Add `elbv2:describe_target_groups` scanner |
`apps/workers/src/jobs/discovery/services/custom-scanners.ts` (modify) | Target-group scanner that attaches target health |
`apps/workers/src/jobs/discovery/services/edge-path.ts` (create) | Pure path resolver + value transforms |
`apps/workers/src/jobs/discovery/services/edge-spec.ts` (create) | Declarative `EDGE_SPECS` table (data only) |
`apps/workers/src/jobs/discovery/services/edge-derivers.ts` (create) | Per-type functions for edges no path can express |
`apps/workers/src/jobs/discovery/services/edge-extractor.ts` (create) | `extractEdges(resources)` orchestrator |
`apps/workers/src/jobs/discovery/services/edge-writer.ts` (create) | Batch upsert + stale reconcile (raw pg) |
`apps/workers/src/jobs/discovery/index.ts` (modify) | Call extractor + writer in the scan loop |
`apps/web-ui/lib/db/repositories/resource-graph/interface.ts` (create) | Repository contract |
`apps/web-ui/lib/db/repositories/resource-graph/postgres.ts` (create) | Recursive-CTE traversal |
`apps/web-ui/lib/db/repository-factory.ts` (modify) | `getResourceGraphRepository()` |
`apps/web-ui/lib/agent/resource-graph-tool.ts` (create) | Two agent tools |
`apps/web-ui/lib/agent/model-factory.ts` (modify) | Register tools |
`apps/web-ui/lib/agent/prompt-templates.ts` (modify) | Instruct the agent to prefer the graph |
`docs/RESOURCE_GRAPH_ARCHITECTURE.md` (create) | Design record + IAM requirement |

---

### Task 1: `resource_edges` table

**Files:**
- Modify: `libs/prisma/schema.prisma` (append after the `InventorySyncStatus` model, ~line 455)
- Create: `libs/prisma/migrations/20260810120000_add_resource_edges/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: table `resource_edges` with columns `id, tenantId, accountId, region, fromType, fromId, relation, toType, toId, toAccountId, jobRunId, isCurrent, discoveredAt, updatedAt`; unique constraint on `(tenantId, accountId, fromType, fromId, relation, toType, toId)`; Prisma model `ResourceEdge`.

- [ ] **Step 1: Add the Prisma model**

In `libs/prisma/schema.prisma`, append:

```prisma
// ResourceEdge — directed relationships between discovered AWS resources.
// Deliberately has NO foreign key to inventory_resources: edge targets often do not
// exist as rows (unscanned region, failed scanner, cross-account VPC peer). A dangling
// edge is valid data. Written by the discovery scan; same isCurrent lifecycle as resources.
model ResourceEdge {
  id           String   @id @default(cuid())
  tenantId     String
  accountId    String
  region       String
  fromType     String
  fromId       String
  relation     String
  toType       String
  toId         String
  // Set only when the target lives in a different AWS account (e.g. VPC peering).
  toAccountId  String?
  jobRunId     String?
  isCurrent    Boolean  @default(true)
  discoveredAt DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([tenantId, accountId, fromType, fromId, relation, toType, toId])
  @@index([tenantId, fromType, fromId, isCurrent])
  @@index([tenantId, toType, toId, isCurrent])
  @@index([tenantId, accountId, isCurrent])
  @@map("resource_edges")
}
```

- [ ] **Step 2: Write the migration SQL**

Create `libs/prisma/migrations/20260810120000_add_resource_edges/migration.sql`:

```sql
CREATE TABLE "resource_edges" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "toAccountId" TEXT,
    "jobRunId" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "resource_edges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "resource_edges_tenant_account_edge_key"
    ON "resource_edges"("tenantId", "accountId", "fromType", "fromId", "relation", "toType", "toId");

CREATE INDEX "resource_edges_forward_idx"
    ON "resource_edges"("tenantId", "fromType", "fromId", "isCurrent");

CREATE INDEX "resource_edges_reverse_idx"
    ON "resource_edges"("tenantId", "toType", "toId", "isCurrent");

CREATE INDEX "resource_edges_account_idx"
    ON "resource_edges"("tenantId", "accountId", "isCurrent");
```

- [ ] **Step 3: Apply the migration and regenerate both clients**

```bash
docker compose up -d postgres
cd apps/web-ui && bun run db:migrate
cd apps/web-ui && bun run db:generate
cd apps/workers && bun run db:generate
```

Expected: migration `20260810120000_add_resource_edges` applies cleanly; both generate steps succeed.

- [ ] **Step 4: Verify the table exists with the expected shape**

```bash
docker compose exec -T postgres psql -U postgres -d nucleus -c '\d resource_edges'
```

Expected: 14 columns; one unique index and three non-unique indexes as named above.

- [ ] **Step 5: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations/20260810120000_add_resource_edges
git commit -m "feat(graph): add resource_edges table for resource dependency graph"
```

---

### Task 2: Target group scanning

Without this, there is no load-balancer → instance edge, which is the highest-value relationship for an ops agent. Target groups also expose a pre-existing ID-extraction hazard that must be fixed first: a target group object carries `VpcId` but no key earlier in `idKeys`, so **every target group in a VPC would collapse onto the VPC's ID** and be deduped away by the unique constraint.

**Files:**
- Modify: `apps/workers/src/jobs/discovery/services/scanner.ts:443-465` (`idKeys`), `:492-500` (`nameKeys`)
- Modify: `apps/workers/src/jobs/discovery/services/custom-scanners.ts` (add scanner + registry entry)
- Modify: `apps/workers/src/jobs/discovery/scanfile.json`
- Test: `apps/workers/src/jobs/discovery/__tests__/scanner.test.ts`, `apps/workers/src/jobs/discovery/__tests__/custom-scanners.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: resource type `elbv2_target_groups` whose `resourceId` is the full `TargetGroupArn`, and whose `rawData` contains `LoadBalancerArns: string[]`, `VpcId`, and an injected `_targetHealth: Array<{ Target: { Id: string } }>`.

- [ ] **Step 1: Write the failing test for target group ID extraction**

Add to `apps/workers/src/jobs/discovery/__tests__/scanner.test.ts`:

```typescript
it('should extract TargetGroupArn as resourceId, not VpcId', () => {
  const ids = extractResourceIdentifiers(
    {
      TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:111:targetgroup/tg-web/abc123',
      TargetGroupName: 'tg-web',
      VpcId: 'vpc-123',
      LoadBalancerArns: ['arn:aws:elasticloadbalancing:us-east-1:111:loadbalancer/app/prod-alb/xyz'],
    },
    'elbv2',
  );

  expect(ids.resourceId).toBe('arn:aws:elasticloadbalancing:us-east-1:111:targetgroup/tg-web/abc123');
  expect(ids.name).toBe('tg-web');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/scanner.test.ts -t 'TargetGroupArn'`
Expected: FAIL — `resourceId` is `'vpc-123'`.

- [ ] **Step 3: Add the keys**

In `apps/workers/src/jobs/discovery/services/scanner.ts`, in `idKeys`, insert `'TargetGroupArn'` immediately **before** `'LoadBalancerArn'` (line 449):

```typescript
    'KeyId', 'AutoScalingGroupName', 'TargetGroupArn', 'LoadBalancerArn', 'TopicArn', 'QueueUrl',
```

In `arnKeys` (line 474), add `'TargetGroupArn'` after `'LoadBalancerArn'`:

```typescript
    'LoadBalancerArn', 'TargetGroupArn', 'TopicArn', 'QueueArn', 'FileSystemArn',
```

In `nameKeys` (line 494), add `'TargetGroupName'` after `'LoadBalancerName'`:

```typescript
    'BucketName', 'AutoScalingGroupName', 'LoadBalancerName', 'TargetGroupName', 'FileSystemId',
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/scanner.test.ts`
Expected: PASS, and all pre-existing scanner tests still pass.

- [ ] **Step 5: Write the failing test for the target-group custom scanner**

Add to `apps/workers/src/jobs/discovery/__tests__/custom-scanners.test.ts`:

```typescript
describe('elbv2:describe_target_groups — targetGroupsWithHealth', () => {
  it('should attach target health to each target group as _targetHealth', async () => {
    const mockClient = {
      send: vi.fn()
        .mockResolvedValueOnce({
          TargetGroups: [{
            TargetGroupArn: 'arn:tg/1',
            TargetGroupName: 'tg-web',
            VpcId: 'vpc-1',
            LoadBalancerArns: ['arn:lb/1'],
          }],
        })
        .mockResolvedValueOnce({
          TargetHealthDescriptions: [
            { Target: { Id: 'i-111' }, TargetHealth: { State: 'healthy' } },
            { Target: { Id: 'i-222' }, TargetHealth: { State: 'unhealthy' } },
          ],
        }),
    };
    const config: ScanConfig = { service: 'elbv2', function: 'describe_target_groups', result_key: 'TargetGroups' };

    const result = await CUSTOM_SCANNERS['elbv2:describe_target_groups'](mockClient, 'us-east-1', config);

    expect(result).toHaveLength(1);
    expect(result[0]._targetHealth).toHaveLength(2);
    expect(result[0]._targetHealth[0].Target.Id).toBe('i-111');
  });

  it('should leave _targetHealth empty when the health call fails', async () => {
    const mockClient = {
      send: vi.fn()
        .mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: 'arn:tg/1' }] })
        .mockRejectedValueOnce(new Error('AccessDenied')),
    };
    const config: ScanConfig = { service: 'elbv2', function: 'describe_target_groups', result_key: 'TargetGroups' };

    const result = await CUSTOM_SCANNERS['elbv2:describe_target_groups'](mockClient, 'us-east-1', config);

    expect(result[0]._targetHealth).toEqual([]);
  });
});
```

Ensure `CUSTOM_SCANNERS` and `ScanConfig` are imported at the top of that test file (the existing tests already import them).

- [ ] **Step 6: Run it and confirm it fails**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/custom-scanners.test.ts -t 'targetGroupsWithHealth'`
Expected: FAIL — `CUSTOM_SCANNERS['elbv2:describe_target_groups']` is not a function.

- [ ] **Step 7: Implement the scanner**

In `apps/workers/src/jobs/discovery/services/custom-scanners.ts`, add before the dispatch map:

```typescript
// ---------------------------------------------------------------------------
// ELBv2 Target Groups — describe groups, then attach target health per group.
// Health is the only source of the load-balancer → instance edge.
// ---------------------------------------------------------------------------

async function targetGroupsWithHealth(
  client: any,
  region: string,
  config: ScanConfig,
): Promise<any[]> {
  const { DescribeTargetGroupsCommand, DescribeTargetHealthCommand } = await import(
    '@aws-sdk/client-elastic-load-balancing-v2'
  );

  const groups: any[] = [];
  let marker: string | undefined;
  do {
    const resp = await client.send(new DescribeTargetGroupsCommand({ Marker: marker }));
    groups.push(...(resp.TargetGroups || []));
    marker = resp.NextMarker;
  } while (marker);

  for (const group of groups) {
    try {
      const health = await client.send(
        new DescribeTargetHealthCommand({ TargetGroupArn: group.TargetGroupArn }),
      );
      group._targetHealth = health.TargetHealthDescriptions || [];
    } catch (error) {
      // A missing permission or a group mid-delete must not fail the whole scan.
      log.warn('Target health lookup failed', {
        region,
        targetGroupArn: group.TargetGroupArn,
        error: error instanceof Error ? error.message : String(error),
      });
      group._targetHealth = [];
    }
  }

  return groups;
}
```

Add to `CUSTOM_SCANNERS`:

```typescript
  'elbv2:describe_target_groups': targetGroupsWithHealth,
```

- [ ] **Step 8: Register the scanner in the scanfile**

In `apps/workers/src/jobs/discovery/scanfile.json`, insert after the `elbv2:describe_load_balancers` entry (line 114):

```json
  {
    "service": "elbv2",
    "function": "describe_target_groups",
    "result_key": "TargetGroups"
  },
```

- [ ] **Step 9: Verify the AWS SDK package is present**

Run: `cd apps/workers && node -e "require.resolve('@aws-sdk/client-elastic-load-balancing-v2')"`
Expected: prints a resolved path. If it throws, run `cd apps/workers && bun add @aws-sdk/client-elastic-load-balancing-v2` and commit the lockfile change with this task.

- [ ] **Step 10: Run the full discovery test suite**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/workers/src/jobs/discovery
git commit -m "feat(discovery): scan ELBv2 target groups with target health"
```

---

### Task 3: Path resolver and value transforms

**Files:**
- Modify: `apps/workers/src/jobs/discovery/types.ts`
- Create: `apps/workers/src/jobs/discovery/services/edge-path.ts`
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface EdgeSpec { path: string; relation: string; toType: string; transform?: EdgeTransform; when?: { path: string; equals: string } }`
  - `type EdgeTransform = 'arn-last-segment' | 'csv'`
  - `interface ResourceEdge { fromType, fromId, relation, toType, toId: string; toAccountId?: string }`
  - `resolvePath(obj: unknown, path: string): unknown[]` — returns every value the path matches, flattened, `[]` when nothing matches.
  - `applyTransform(value: string, transform?: EdgeTransform): string[]`

- [ ] **Step 1: Add the types**

Append to `apps/workers/src/jobs/discovery/types.ts`:

```typescript
// ---------------------------------------------------------------------------
// Resource dependency graph
// ---------------------------------------------------------------------------

export type EdgeTransform = 'arn-last-segment' | 'csv';

export interface EdgeSpec {
  // Dot path into rawData. Use `[]` to fan out over an array:
  //   'VpcId'                              → scalar
  //   'DBSubnetGroup.VpcId'                → nested scalar
  //   'SecurityGroups[].GroupId'           → array of objects
  //   'resourcesVpcConfig.subnetIds[]'     → array of scalars
  //   'BlockDeviceMappings[].Ebs.VolumeId' → array of nested objects
  path: string;
  relation: string;
  toType: string;
  transform?: EdgeTransform;
  // Emit the edge only when another path equals this value (e.g. TGW attachments
  // whose ResourceType is 'vpc').
  when?: { path: string; equals: string };
}

export interface ResourceEdge {
  fromType: string;
  fromId: string;
  relation: string;
  toType: string;
  toId: string;
  toAccountId?: string;
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/workers/src/jobs/discovery/__tests__/edge-path.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolvePath, applyTransform } from '../services/edge-path.js';

describe('resolvePath', () => {
  it('resolves a scalar', () => {
    expect(resolvePath({ VpcId: 'vpc-1' }, 'VpcId')).toEqual(['vpc-1']);
  });

  it('resolves a nested scalar', () => {
    expect(resolvePath({ DBSubnetGroup: { VpcId: 'vpc-1' } }, 'DBSubnetGroup.VpcId')).toEqual(['vpc-1']);
  });

  it('fans out over an array of objects', () => {
    const raw = { SecurityGroups: [{ GroupId: 'sg-1' }, { GroupId: 'sg-2' }] };
    expect(resolvePath(raw, 'SecurityGroups[].GroupId')).toEqual(['sg-1', 'sg-2']);
  });

  it('fans out over an array of scalars', () => {
    const raw = { resourcesVpcConfig: { subnetIds: ['subnet-1', 'subnet-2'] } };
    expect(resolvePath(raw, 'resourcesVpcConfig.subnetIds[]')).toEqual(['subnet-1', 'subnet-2']);
  });

  it('resolves nested objects inside an array', () => {
    const raw = { BlockDeviceMappings: [{ Ebs: { VolumeId: 'vol-1' } }, { Ebs: { VolumeId: 'vol-2' } }] };
    expect(resolvePath(raw, 'BlockDeviceMappings[].Ebs.VolumeId')).toEqual(['vol-1', 'vol-2']);
  });

  it('returns empty for a missing path', () => {
    expect(resolvePath({ VpcId: 'vpc-1' }, 'SubnetId')).toEqual([]);
  });

  it('skips null and undefined entries', () => {
    const raw = { SecurityGroups: [{ GroupId: 'sg-1' }, { GroupId: null }, {}] };
    expect(resolvePath(raw, 'SecurityGroups[].GroupId')).toEqual(['sg-1']);
  });

  it('returns empty for non-object input', () => {
    expect(resolvePath('a-string', 'VpcId')).toEqual([]);
    expect(resolvePath(null, 'VpcId')).toEqual([]);
  });
});

describe('applyTransform', () => {
  it('returns the value unchanged with no transform', () => {
    expect(applyTransform('vpc-1')).toEqual(['vpc-1']);
  });

  it('takes the last ARN segment', () => {
    expect(applyTransform('arn:aws:iam::111:role/my-role', 'arn-last-segment')).toEqual(['my-role']);
    expect(applyTransform('arn:aws:kms:us-east-1:111:key/abc-def', 'arn-last-segment')).toEqual(['abc-def']);
  });

  it('takes the final segment of a pathed role ARN', () => {
    expect(applyTransform('arn:aws:iam::111:role/team/app-role', 'arn-last-segment')).toEqual(['app-role']);
  });

  it('leaves non-ARN values alone under arn-last-segment', () => {
    expect(applyTransform('abc-def-key-id', 'arn-last-segment')).toEqual(['abc-def-key-id']);
  });

  it('splits csv and trims', () => {
    expect(applyTransform('subnet-1, subnet-2', 'csv')).toEqual(['subnet-1', 'subnet-2']);
  });

  it('drops empty csv segments', () => {
    expect(applyTransform('subnet-1,,subnet-2,', 'csv')).toEqual(['subnet-1', 'subnet-2']);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/edge-path.test.ts`
Expected: FAIL — cannot resolve `../services/edge-path.js`.

- [ ] **Step 4: Implement the resolver**

Create `apps/workers/src/jobs/discovery/services/edge-path.ts`:

```typescript
// workers/src/jobs/discovery/services/edge-path.ts
import type { EdgeTransform } from '../types.js';

export function resolvePath(obj: unknown, path: string): unknown[] {
  if (obj === null || typeof obj !== 'object') return [];

  const segments = path.split('.');
  let current: unknown[] = [obj];

  for (const segment of segments) {
    const fanOut = segment.endsWith('[]');
    const key = fanOut ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];

    for (const node of current) {
      if (node === null || typeof node !== 'object') continue;
      const value = (node as Record<string, unknown>)[key];
      if (value === null || value === undefined) continue;

      if (fanOut) {
        if (Array.isArray(value)) next.push(...value.filter((v) => v !== null && v !== undefined));
      } else {
        next.push(value);
      }
    }

    current = next;
    if (!current.length) return [];
  }

  return current;
}

export function applyTransform(value: string, transform?: EdgeTransform): string[] {
  if (transform === 'csv') {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  if (transform === 'arn-last-segment') {
    if (!value.startsWith('arn:')) return [value];
    const last = value.split('/').pop();
    return last ? [last] : [];
  }
  return [value];
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/edge-path.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/workers/src/jobs/discovery/types.ts apps/workers/src/jobs/discovery/services/edge-path.ts apps/workers/src/jobs/discovery/__tests__/edge-path.test.ts
git commit -m "feat(graph): add edge path resolver and value transforms"
```

---

### Task 4: The declarative edge spec

This is the coverage table. Each `toType`'s ID convention was verified against `extractResourceIdentifiers`; the comments record why a given transform is or is not applied. `ec2_addresses` is absent by design (see Known Pre-Existing Issues).

**Files:**
- Create: `apps/workers/src/jobs/discovery/services/edge-spec.ts`
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-spec.test.ts`

**Interfaces:**
- Consumes: `EdgeSpec` from `../types.js`.
- Produces: `EDGE_SPECS: Record<string, EdgeSpec[]>` keyed by source `resourceType`.

- [ ] **Step 1: Write the spec table**

Create `apps/workers/src/jobs/discovery/services/edge-spec.ts`:

```typescript
// workers/src/jobs/discovery/services/edge-spec.ts
import type { EdgeSpec } from '../types.js';

// Target-type resourceId conventions (verified against extractResourceIdentifiers):
//   ec2_*                          native ids (vpc-, subnet-, sg-, vol-, eni-, nat-)
//   elbv2_load_balancers           full LoadBalancerArn
//   elbv2_target_groups            full TargetGroupArn
//   rds_db_instances               DBInstanceIdentifier
//   rds_db_clusters/docdb_*        DBClusterIdentifier
//   lambda_functions               FunctionName
//   iam_roles                      RoleName        → ARNs need arn-last-segment
//   kms_keys                       KeyId (uuid)    → ARNs need arn-last-segment
//   sns_topics                     full TopicArn   → NO transform
//   ecs_clusters                   full clusterArn → NO transform
//   eks_clusters                   cluster name
//   s3_buckets                     bucket name
//   acm_certificates               full CertificateArn → NO transform
//   elasticache_cache_clusters     CacheClusterId
//   efs_file_systems               FileSystemId
//   dynamodb_tables                TableName
//   ecr_repositories               repositoryName
//   autoscaling_auto_scaling_groups AutoScalingGroupName

export const EDGE_SPECS: Record<string, EdgeSpec[]> = {
  ec2_instances: [
    { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
    { path: 'SubnetId', relation: 'in_subnet', toType: 'ec2_subnets' },
    { path: 'SecurityGroups[].GroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
    { path: 'BlockDeviceMappings[].Ebs.VolumeId', relation: 'has_volume', toType: 'ec2_volumes' },
    { path: 'NetworkInterfaces[].NetworkInterfaceId', relation: 'has_network_interface', toType: 'ec2_network_interfaces' },
    // IamInstanceProfile.Arn is a profile ARN; the profile name usually equals the role
    // name but is not guaranteed to. Treated as best-effort.
    { path: 'IamInstanceProfile.Arn', relation: 'uses_iam_role', toType: 'iam_roles', transform: 'arn-last-segment' },
  ],

  ec2_subnets: [
    { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
  ],

  ec2_security_groups: [
    { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
    // SG-to-SG references. These create cycles in the graph — traversal must cap depth.
    { path: 'IpPermissions[].UserIdGroupPairs[].GroupId', relation: 'allows_ingress_from', toType: 'ec2_security_groups' },
    { path: 'IpPermissionsEgress[].UserIdGroupPairs[].GroupId', relation: 'allows_egress_to', toType: 'ec2_security_groups' },
  ],

  ec2_volumes: [
    { path: 'Attachments[].InstanceId', relation: 'attached_to', toType: 'ec2_instances' },
    { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
  ],

  ec2_network_interfaces: [
    { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
    { path: 'SubnetId', relation: 'in_subnet', toType: 'ec2_subnets' },
    { path: 'Groups[].GroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
    { path: 'Attachment.InstanceId', relation: 'attached_to', toType: 'ec2_instances' },
  ],

  ec2_nat_gateways: [
    { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
    { path: 'SubnetId', relation: 'in_subnet', toType: 'ec2_subnets' },
    { path: 'NatGatewayAddresses[].NetworkInterfaceId', relation: 'has_network_interface', toType: 'ec2_network_interfaces' },
  ],

  ec2_vpc_peering_connections: [
    { path: 'RequesterVpcInfo.VpcId', relation: 'peers_vpc', toType: 'ec2_vpcs' },
    { path: 'AccepterVpcInfo.VpcId', relation: 'peers_vpc', toType: 'ec2_vpcs' },
  ],

  ec2_transit_gateway_attachments: [
    { path: 'TransitGatewayId', relation: 'attached_to_tgw', toType: 'ec2_transit_gateways' },
    { path: 'ResourceId', relation: 'attaches_vpc', toType: 'ec2_vpcs', when: { path: 'ResourceType', equals: 'vpc' } },
  ],

  rds_db_instances: [
    { path: 'DBSubnetGroup.VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
    { path: 'DBSubnetGroup.Subnets[].SubnetIdentifier', relation: 'in_subnet', toType: 'ec2_subnets' },
    { path: 'VpcSecurityGroups[].VpcSecurityGroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
    { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
    { path: 'DBClusterIdentifier', relation: 'member_of_cluster', toType: 'rds_db_clusters' },
  ],

  rds_db_clusters: [
    { path: 'VpcSecurityGroups[].VpcSecurityGroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
    { path: 'DBClusterMembers[].DBInstanceIdentifier', relation: 'has_member', toType: 'rds_db_instances' },
    { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
  ],

  docdb_db_clusters: [
    { path: 'VpcSecurityGroups[].VpcSecurityGroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
    { path: 'DBClusterMembers[].DBInstanceIdentifier', relation: 'has_member', toType: 'rds_db_instances' },
    { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
  ],

  elbv2_load_balancers: [
    { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
    { path: 'AvailabilityZones[].SubnetId', relation: 'in_subnet', toType: 'ec2_subnets' },
    { path: 'SecurityGroups[]', relation: 'uses_security_group', toType: 'ec2_security_groups' },
  ],

  elbv2_target_groups: [
    { path: 'VpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
    { path: 'LoadBalancerArns[]', relation: 'attached_to_load_balancer', toType: 'elbv2_load_balancers' },
    // _targetHealth is injected by the targetGroupsWithHealth custom scanner (Task 2).
    // Target.Id is an instance id for instance-type groups; for ip/lambda groups it is an
    // IP or function ARN and will simply dangle, which is acceptable.
    { path: '_targetHealth[].Target.Id', relation: 'routes_to_instance', toType: 'ec2_instances' },
  ],

  autoscaling_auto_scaling_groups: [
    { path: 'Instances[].InstanceId', relation: 'has_member', toType: 'ec2_instances' },
    { path: 'VPCZoneIdentifier', relation: 'in_subnet', toType: 'ec2_subnets', transform: 'csv' },
    { path: 'TargetGroupARNs[]', relation: 'registers_with_target_group', toType: 'elbv2_target_groups' },
  ],

  lambda_functions: [
    { path: 'VpcConfig.SubnetIds[]', relation: 'in_subnet', toType: 'ec2_subnets' },
    { path: 'VpcConfig.SecurityGroupIds[]', relation: 'uses_security_group', toType: 'ec2_security_groups' },
    { path: 'Role', relation: 'uses_iam_role', toType: 'iam_roles', transform: 'arn-last-segment' },
    { path: 'KMSKeyArn', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
  ],

  ecs_services: [
    // describe_services (via the ecsServicesDeep custom scanner) returns clusterArn
    // directly — no ARN parsing needed, and ecs_clusters ids are full ARNs.
    { path: 'clusterArn', relation: 'in_cluster', toType: 'ecs_clusters' },
    { path: 'networkConfiguration.awsvpcConfiguration.subnets[]', relation: 'in_subnet', toType: 'ec2_subnets' },
    { path: 'networkConfiguration.awsvpcConfiguration.securityGroups[]', relation: 'uses_security_group', toType: 'ec2_security_groups' },
    { path: 'loadBalancers[].targetGroupArn', relation: 'registers_with_target_group', toType: 'elbv2_target_groups' },
  ],

  eks_clusters: [
    { path: 'resourcesVpcConfig.vpcId', relation: 'in_vpc', toType: 'ec2_vpcs' },
    { path: 'resourcesVpcConfig.subnetIds[]', relation: 'in_subnet', toType: 'ec2_subnets' },
    { path: 'resourcesVpcConfig.securityGroupIds[]', relation: 'uses_security_group', toType: 'ec2_security_groups' },
    { path: 'resourcesVpcConfig.clusterSecurityGroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
    { path: 'roleArn', relation: 'uses_iam_role', toType: 'iam_roles', transform: 'arn-last-segment' },
    { path: 'encryptionConfig[].provider.keyArn', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
  ],

  elasticache_cache_clusters: [
    { path: 'SecurityGroups[].SecurityGroupId', relation: 'uses_security_group', toType: 'ec2_security_groups' },
  ],

  efs_file_systems: [
    { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
  ],

  dynamodb_tables: [
    { path: 'SSEDescription.KMSMasterKeyArn', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
  ],

  ecr_repositories: [
    { path: 'encryptionConfiguration.kmsKey', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
  ],

  secretsmanager_secrets: [
    { path: 'KmsKeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
  ],

  ssm_parameters: [
    { path: 'KeyId', relation: 'encrypted_with', toType: 'kms_keys', transform: 'arn-last-segment' },
  ],

  cloudfront_distributions: [
    { path: 'ViewerCertificate.ACMCertificateArn', relation: 'uses_certificate', toType: 'acm_certificates' },
  ],
};
```

- [ ] **Step 2: Write a test that guards the spec's integrity**

Create `apps/workers/src/jobs/discovery/__tests__/edge-spec.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { EDGE_SPECS } from '../services/edge-spec.js';

describe('EDGE_SPECS', () => {
  it('covers the six core resource types', () => {
    for (const type of [
      'ec2_instances',
      'ec2_subnets',
      'ec2_security_groups',
      'ec2_volumes',
      'rds_db_instances',
      'elbv2_load_balancers',
    ]) {
      expect(EDGE_SPECS[type], `missing spec for ${type}`).toBeDefined();
      expect(EDGE_SPECS[type].length).toBeGreaterThan(0);
    }
  });

  it('provides a load-balancer to instance path via target groups', () => {
    const tg = EDGE_SPECS.elbv2_target_groups;
    expect(tg.some((s) => s.toType === 'elbv2_load_balancers')).toBe(true);
    expect(tg.some((s) => s.toType === 'ec2_instances')).toBe(true);
  });

  it('never emits an edge for ec2_addresses (wrong resourceId, see plan)', () => {
    expect(EDGE_SPECS.ec2_addresses).toBeUndefined();
  });

  it('uses arn-last-segment for every kms_keys and iam_roles target', () => {
    for (const [fromType, specs] of Object.entries(EDGE_SPECS)) {
      for (const spec of specs) {
        if (spec.toType === 'kms_keys' || spec.toType === 'iam_roles') {
          expect(spec.transform, `${fromType} → ${spec.toType} must transform ARNs`).toBe('arn-last-segment');
        }
      }
    }
  });

  it('never transforms sns_topics, ecs_clusters or acm_certificates targets (ids are full ARNs)', () => {
    for (const specs of Object.values(EDGE_SPECS)) {
      for (const spec of specs) {
        if (['sns_topics', 'ecs_clusters', 'acm_certificates'].includes(spec.toType)) {
          expect(spec.transform).toBeUndefined();
        }
      }
    }
  });

  it('gives every spec a non-empty path, relation and toType', () => {
    for (const specs of Object.values(EDGE_SPECS)) {
      for (const spec of specs) {
        expect(spec.path).toBeTruthy();
        expect(spec.relation).toBeTruthy();
        expect(spec.toType).toBeTruthy();
      }
    }
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/edge-spec.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/workers/src/jobs/discovery/services/edge-spec.ts apps/workers/src/jobs/discovery/__tests__/edge-spec.test.ts
git commit -m "feat(graph): add declarative edge spec covering 23 resource types"
```

---

### Task 5: Custom derivers for edges no path can express

Two source types need real logic. CloudWatch alarms carry their monitored resource in a `Dimensions` name/value array, so the *name* selects the target type. CloudFront origins identify targets by DNS hostname, which has to be pattern-matched.

**Files:**
- Create: `apps/workers/src/jobs/discovery/services/edge-derivers.ts`
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-derivers.test.ts`

**Interfaces:**
- Consumes: `ResourceEdge` from `../types.js`.
- Produces: `CUSTOM_DERIVERS: Record<string, (raw: Record<string, any>, fromId: string) => ResourceEdge[]>`, keyed by source `resourceType`. Each returned edge has `fromType` set by the deriver.

- [ ] **Step 1: Write the failing tests**

Create `apps/workers/src/jobs/discovery/__tests__/edge-derivers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CUSTOM_DERIVERS } from '../services/edge-derivers.js';

describe('cloudwatch_alarms deriver', () => {
  const derive = CUSTOM_DERIVERS.cloudwatch_alarms;

  it('maps an InstanceId dimension to an ec2_instances edge', () => {
    const edges = derive({ Dimensions: [{ Name: 'InstanceId', Value: 'i-111' }] }, 'cpu-high');
    expect(edges).toEqual([
      { fromType: 'cloudwatch_alarms', fromId: 'cpu-high', relation: 'monitors', toType: 'ec2_instances', toId: 'i-111' },
    ]);
  });

  it('maps a DBInstanceIdentifier dimension to rds_db_instances', () => {
    const edges = derive({ Dimensions: [{ Name: 'DBInstanceIdentifier', Value: 'prod-db' }] }, 'db-conn');
    expect(edges[0].toType).toBe('rds_db_instances');
    expect(edges[0].toId).toBe('prod-db');
  });

  it('maps AlarmActions SNS arns to sns_topics with the full arn preserved', () => {
    const edges = derive({ AlarmActions: ['arn:aws:sns:us-east-1:111:ops-alerts'] }, 'cpu-high');
    expect(edges).toEqual([
      {
        fromType: 'cloudwatch_alarms',
        fromId: 'cpu-high',
        relation: 'notifies',
        toType: 'sns_topics',
        toId: 'arn:aws:sns:us-east-1:111:ops-alerts',
      },
    ]);
  });

  it('ignores non-SNS alarm actions', () => {
    const edges = derive({ AlarmActions: ['arn:aws:autoscaling:us-east-1:111:scalingPolicy:xyz'] }, 'cpu-high');
    expect(edges).toEqual([]);
  });

  it('ignores unrecognised dimension names', () => {
    expect(derive({ Dimensions: [{ Name: 'SomeCustomDimension', Value: 'x' }] }, 'a')).toEqual([]);
  });

  it('returns empty for an alarm with no dimensions or actions', () => {
    expect(derive({}, 'a')).toEqual([]);
  });
});

describe('cloudfront_distributions deriver', () => {
  const derive = CUSTOM_DERIVERS.cloudfront_distributions;

  it('maps an s3 origin domain to an s3_buckets edge', () => {
    const edges = derive(
      { Origins: { Items: [{ DomainName: 'my-assets.s3.us-east-1.amazonaws.com' }] } },
      'E123',
    );
    expect(edges).toEqual([
      { fromType: 'cloudfront_distributions', fromId: 'E123', relation: 'origin_is', toType: 's3_buckets', toId: 'my-assets' },
    ]);
  });

  it('handles the legacy global s3 domain form', () => {
    const edges = derive({ Origins: { Items: [{ DomainName: 'my-assets.s3.amazonaws.com' }] } }, 'E123');
    expect(edges[0].toId).toBe('my-assets');
  });

  it('ignores non-s3 origin domains', () => {
    const edges = derive({ Origins: { Items: [{ DomainName: 'prod-alb-1.us-east-1.elb.amazonaws.com' }] } }, 'E123');
    expect(edges).toEqual([]);
  });

  it('returns empty when there are no origins', () => {
    expect(derive({}, 'E123')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/edge-derivers.test.ts`
Expected: FAIL — cannot resolve `../services/edge-derivers.js`.

- [ ] **Step 3: Implement the derivers**

Create `apps/workers/src/jobs/discovery/services/edge-derivers.ts`:

```typescript
// workers/src/jobs/discovery/services/edge-derivers.ts
import type { ResourceEdge } from '../types.js';

type Deriver = (raw: Record<string, any>, fromId: string) => ResourceEdge[];

// CloudWatch alarm Dimensions carry the monitored resource; the dimension NAME
// selects which resource type the value refers to.
const DIMENSION_TO_TYPE: Record<string, string> = {
  InstanceId: 'ec2_instances',
  DBInstanceIdentifier: 'rds_db_instances',
  DBClusterIdentifier: 'rds_db_clusters',
  AutoScalingGroupName: 'autoscaling_auto_scaling_groups',
  FunctionName: 'lambda_functions',
  TableName: 'dynamodb_tables',
  CacheClusterId: 'elasticache_cache_clusters',
  BucketName: 's3_buckets',
  FileSystemId: 'efs_file_systems',
  QueueName: 'sqs_queues',
  ClusterName: 'ecs_clusters',
};

const cloudwatchAlarms: Deriver = (raw, fromId) => {
  const edges: ResourceEdge[] = [];

  for (const dim of raw.Dimensions || []) {
    const toType = DIMENSION_TO_TYPE[dim?.Name];
    if (!toType || !dim?.Value) continue;
    edges.push({
      fromType: 'cloudwatch_alarms',
      fromId,
      relation: 'monitors',
      toType,
      toId: dim.Value,
    });
  }

  // sns_topics resourceId is the full TopicArn, so the arn is used verbatim.
  for (const action of raw.AlarmActions || []) {
    if (typeof action !== 'string' || !action.startsWith('arn:aws:sns:')) continue;
    edges.push({
      fromType: 'cloudwatch_alarms',
      fromId,
      relation: 'notifies',
      toType: 'sns_topics',
      toId: action,
    });
  }

  return edges;
};

// CloudFront origins name their target by DNS hostname. Only the S3 form is
// unambiguous enough to match; ALB origin hostnames do not contain the load
// balancer ARN, so those edges are intentionally not derived.
const S3_ORIGIN = /^(.+?)\.s3[.-](?:[a-z0-9-]+\.)?amazonaws\.com$/;

const cloudfrontDistributions: Deriver = (raw, fromId) => {
  const edges: ResourceEdge[] = [];

  for (const origin of raw.Origins?.Items || []) {
    const match = S3_ORIGIN.exec(origin?.DomainName || '');
    if (!match) continue;
    edges.push({
      fromType: 'cloudfront_distributions',
      fromId,
      relation: 'origin_is',
      toType: 's3_buckets',
      toId: match[1],
    });
  }

  return edges;
};

export const CUSTOM_DERIVERS: Record<string, Deriver> = {
  cloudwatch_alarms: cloudwatchAlarms,
  cloudfront_distributions: cloudfrontDistributions,
};
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/edge-derivers.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/jobs/discovery/services/edge-derivers.ts apps/workers/src/jobs/discovery/__tests__/edge-derivers.test.ts
git commit -m "feat(graph): derive alarm and cloudfront origin edges"
```

---

### Task 6: The edge extractor

**Files:**
- Create: `apps/workers/src/jobs/discovery/services/edge-extractor.ts`
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-extractor.test.ts`

**Interfaces:**
- Consumes: `resolvePath`, `applyTransform` (Task 3); `EDGE_SPECS` (Task 4); `CUSTOM_DERIVERS` (Task 5); `Resource`, `ResourceEdge` (Task 3).
- Produces: `extractEdges(resources: Resource[]): ResourceEdge[]` — deduplicated, self-edges removed, empty `toId`s dropped.

- [ ] **Step 1: Write the failing tests**

Create `apps/workers/src/jobs/discovery/__tests__/edge-extractor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractEdges } from '../services/edge-extractor.js';
import type { Resource } from '../types.js';

const resource = (over: Partial<Resource>): Resource => ({
  resourceType: 'ec2_instances',
  resourceId: 'i-111',
  region: 'us-east-1',
  service: 'ec2',
  tags: {},
  rawData: {},
  ...over,
});

describe('extractEdges', () => {
  it('extracts all spec edges from one EC2 instance', () => {
    const edges = extractEdges([
      resource({
        rawData: {
          InstanceId: 'i-111',
          VpcId: 'vpc-1',
          SubnetId: 'subnet-1',
          SecurityGroups: [{ GroupId: 'sg-1' }, { GroupId: 'sg-2' }],
          BlockDeviceMappings: [{ Ebs: { VolumeId: 'vol-1' } }],
        },
      }),
    ]);

    expect(edges).toHaveLength(5);
    expect(edges).toContainEqual({
      fromType: 'ec2_instances', fromId: 'i-111', relation: 'in_vpc', toType: 'ec2_vpcs', toId: 'vpc-1',
    });
    expect(edges.filter((e) => e.toType === 'ec2_security_groups')).toHaveLength(2);
  });

  it('applies the csv transform for ASG subnets', () => {
    const edges = extractEdges([
      resource({
        resourceType: 'autoscaling_auto_scaling_groups',
        resourceId: 'asg-web',
        rawData: { VPCZoneIdentifier: 'subnet-1,subnet-2' },
      }),
    ]);

    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.toId).sort()).toEqual(['subnet-1', 'subnet-2']);
  });

  it('honours a when-condition', () => {
    const vpcAttachment = extractEdges([
      resource({
        resourceType: 'ec2_transit_gateway_attachments',
        resourceId: 'tgw-attach-1',
        rawData: { TransitGatewayId: 'tgw-1', ResourceId: 'vpc-1', ResourceType: 'vpc' },
      }),
    ]);
    expect(vpcAttachment.some((e) => e.toType === 'ec2_vpcs' && e.toId === 'vpc-1')).toBe(true);

    const vpnAttachment = extractEdges([
      resource({
        resourceType: 'ec2_transit_gateway_attachments',
        resourceId: 'tgw-attach-2',
        rawData: { TransitGatewayId: 'tgw-1', ResourceId: 'vpn-1', ResourceType: 'vpn' },
      }),
    ]);
    expect(vpnAttachment.some((e) => e.toType === 'ec2_vpcs')).toBe(false);
  });

  it('runs custom derivers', () => {
    const edges = extractEdges([
      resource({
        resourceType: 'cloudwatch_alarms',
        resourceId: 'cpu-high',
        rawData: { Dimensions: [{ Name: 'InstanceId', Value: 'i-999' }] },
      }),
    ]);

    expect(edges).toEqual([
      { fromType: 'cloudwatch_alarms', fromId: 'cpu-high', relation: 'monitors', toType: 'ec2_instances', toId: 'i-999' },
    ]);
  });

  it('deduplicates identical edges', () => {
    const edges = extractEdges([
      resource({ rawData: { VpcId: 'vpc-1' } }),
      resource({ rawData: { VpcId: 'vpc-1' } }),
    ]);
    expect(edges).toHaveLength(1);
  });

  it('drops self-edges', () => {
    const edges = extractEdges([
      resource({
        resourceType: 'ec2_security_groups',
        resourceId: 'sg-1',
        rawData: { IpPermissions: [{ UserIdGroupPairs: [{ GroupId: 'sg-1' }] }] },
      }),
    ]);
    expect(edges).toEqual([]);
  });

  it('ignores resource types with no spec and no deriver', () => {
    expect(extractEdges([resource({ resourceType: 'iam_users', resourceId: 'alice', rawData: { UserName: 'alice' } })])).toEqual([]);
  });

  it('skips resources with a blank resourceId', () => {
    expect(extractEdges([resource({ resourceId: '', rawData: { VpcId: 'vpc-1' } })])).toEqual([]);
  });

  it('tolerates string rawData', () => {
    expect(extractEdges([resource({ resourceType: 'ecs_clusters', resourceId: 'arn:x', rawData: 'arn:x' })])).toEqual([]);
  });

  it('coerces non-string path values to strings', () => {
    const edges = extractEdges([
      resource({ resourceType: 'ec2_subnets', resourceId: 'subnet-1', rawData: { VpcId: 12345 } }),
    ]);
    expect(edges[0].toId).toBe('12345');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/edge-extractor.test.ts`
Expected: FAIL — cannot resolve `../services/edge-extractor.js`.

- [ ] **Step 3: Implement the extractor**

Create `apps/workers/src/jobs/discovery/services/edge-extractor.ts`:

```typescript
// workers/src/jobs/discovery/services/edge-extractor.ts
import type { Resource, ResourceEdge } from '../types.js';
import { resolvePath, applyTransform } from './edge-path.js';
import { EDGE_SPECS } from './edge-spec.js';
import { CUSTOM_DERIVERS } from './edge-derivers.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('discovery/edge-extractor');

export function extractEdges(resources: Resource[]): ResourceEdge[] {
  const seen = new Map<string, ResourceEdge>();

  const add = (edge: ResourceEdge) => {
    if (!edge.toId || !edge.fromId) return;
    if (edge.fromType === edge.toType && edge.fromId === edge.toId) return;
    seen.set(
      `${edge.fromType}|${edge.fromId}|${edge.relation}|${edge.toType}|${edge.toId}`,
      edge,
    );
  };

  for (const resource of resources) {
    if (!resource.resourceId) continue;

    const raw = resource.rawData;
    if (raw === null || typeof raw !== 'object') continue;
    const rawObj = raw as Record<string, any>;

    for (const spec of EDGE_SPECS[resource.resourceType] || []) {
      if (spec.when) {
        const actual = resolvePath(rawObj, spec.when.path);
        if (!actual.some((v) => String(v) === spec.when!.equals)) continue;
      }

      for (const value of resolvePath(rawObj, spec.path)) {
        if (typeof value === 'object') continue;
        for (const toId of applyTransform(String(value), spec.transform)) {
          add({
            fromType: resource.resourceType,
            fromId: resource.resourceId,
            relation: spec.relation,
            toType: spec.toType,
            toId,
          });
        }
      }
    }

    const deriver = CUSTOM_DERIVERS[resource.resourceType];
    if (deriver) {
      for (const edge of deriver(rawObj, resource.resourceId)) add(edge);
    }
  }

  const edges = Array.from(seen.values());
  log.debug('Extracted edges', { resources: resources.length, edges: edges.length });
  return edges;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/edge-extractor.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/jobs/discovery/services/edge-extractor.ts apps/workers/src/jobs/discovery/__tests__/edge-extractor.test.ts
git commit -m "feat(graph): add edge extractor over specs and derivers"
```

---

### Task 7: The edge writer

Mirrors `writeResourcesToPg` / `reconcileStaleResources` exactly, including the manual `tenantId` predicate.

**Files:**
- Create: `apps/workers/src/jobs/discovery/services/edge-writer.ts`
- Test: `apps/workers/src/jobs/discovery/__tests__/edge-writer.test.ts`

**Interfaces:**
- Consumes: `ResourceEdge` (Task 3); `getPool` from `./db.js`.
- Produces:
  - `writeEdgesToPg(edges: ResourceEdge[], tenantId: string, accountId: string, region: string, jobRunId: string): Promise<number>`
  - `reconcileStaleEdges(tenantId: string, accountId: string, jobRunId: string): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Create `apps/workers/src/jobs/discovery/__tests__/edge-writer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResourceEdge } from '../types.js';

const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ connect: mockConnect })),
}));

import { writeEdgesToPg, reconcileStaleEdges } from '../services/edge-writer.js';

const edge = (over: Partial<ResourceEdge> = {}): ResourceEdge => ({
  fromType: 'ec2_instances',
  fromId: 'i-111',
  relation: 'in_vpc',
  toType: 'ec2_vpcs',
  toId: 'vpc-1',
  ...over,
});

describe('edge-writer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  });

  it('upserts edges with ON CONFLICT', async () => {
    const count = await writeEdgesToPg([edge()], 'tenant-1', 'acc-1', 'us-east-1', 'job-1');

    expect(count).toBe(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO resource_edges'),
      expect.any(Array),
    );
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), expect.any(Array));
    expect(mockRelease).toHaveBeenCalled();
  });

  it('passes tenantId as a bound parameter', async () => {
    await writeEdgesToPg([edge()], 'tenant-1', 'acc-1', 'us-east-1', 'job-1');
    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain('tenant-1');
  });

  it('returns 0 and issues no query for an empty array', async () => {
    const count = await writeEdgesToPg([], 'tenant-1', 'acc-1', 'us-east-1', 'job-1');
    expect(count).toBe(0);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('batches in chunks of 500', async () => {
    const edges = Array.from({ length: 1001 }, (_, i) => edge({ toId: `vpc-${i}` }));
    const count = await writeEdgesToPg(edges, 'tenant-1', 'acc-1', 'us-east-1', 'job-1');

    expect(count).toBe(1001);
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('reconcile scopes to tenant and account and never deletes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 4 });
    const stale = await reconcileStaleEdges('tenant-1', 'acc-1', 'job-1');

    expect(stale).toBe(4);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('UPDATE resource_edges');
    expect(sql).toContain('"tenantId" = $1');
    expect(sql).toContain('"accountId" = $2');
    expect(sql).not.toContain('DELETE');
    expect(params).toEqual(['tenant-1', 'acc-1', 'job-1']);
  });

  it('releases the client when the query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    await expect(writeEdgesToPg([edge()], 'tenant-1', 'acc-1', 'us-east-1', 'job-1')).rejects.toThrow('boom');
    expect(mockRelease).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/edge-writer.test.ts`
Expected: FAIL — cannot resolve `../services/edge-writer.js`.

- [ ] **Step 3: Implement the writer**

Create `apps/workers/src/jobs/discovery/services/edge-writer.ts`:

```typescript
// workers/src/jobs/discovery/services/edge-writer.ts
import type { PoolClient } from 'pg';
import type { ResourceEdge } from '../types.js';
import { getPool } from './db.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('discovery/edge-writer');

const BATCH_SIZE = 500;

export async function writeEdgesToPg(
  edges: ResourceEdge[],
  tenantId: string,
  accountId: string,
  region: string,
  jobRunId: string,
): Promise<number> {
  if (!edges.length) return 0;

  const client: PoolClient = await getPool().connect();
  let total = 0;

  try {
    for (let i = 0; i < edges.length; i += BATCH_SIZE) {
      const batch = edges.slice(i, i + BATCH_SIZE);
      const placeholders: string[] = [];
      const params: any[] = [];
      let p = 1;

      for (const e of batch) {
        const id = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        placeholders.push(
          `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8}, $${p + 9}, $${p + 10}, true, NOW(), NOW())`,
        );
        params.push(
          id,
          tenantId,
          accountId,
          region,
          e.fromType,
          e.fromId,
          e.relation,
          e.toType,
          e.toId,
          e.toAccountId ?? null,
          jobRunId,
        );
        p += 11;
      }

      const sql = `
        INSERT INTO resource_edges
          (id, "tenantId", "accountId", region, "fromType", "fromId",
           relation, "toType", "toId", "toAccountId", "jobRunId",
           "isCurrent", "discoveredAt", "updatedAt")
        VALUES ${placeholders.join(', ')}
        ON CONFLICT ("tenantId", "accountId", "fromType", "fromId", relation, "toType", "toId")
        DO UPDATE SET
          region = EXCLUDED.region,
          "toAccountId" = EXCLUDED."toAccountId",
          "jobRunId" = EXCLUDED."jobRunId",
          "discoveredAt" = EXCLUDED."discoveredAt",
          "updatedAt" = NOW(),
          "isCurrent" = true
      `;

      await client.query(sql, params);
      total += batch.length;
    }
  } catch (error) {
    log.error('Failed writing edges', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    client.release();
  }

  log.debug('Wrote edges', { tenantId, accountId, count: total });
  return total;
}

// Marks edges not seen in the current scan as isCurrent = false. Never deletes:
// historical edges are useful for "what changed since last week".
export async function reconcileStaleEdges(
  tenantId: string,
  accountId: string,
  jobRunId: string,
): Promise<number> {
  const client: PoolClient = await getPool().connect();
  try {
    const result = await client.query(
      `UPDATE resource_edges
       SET "isCurrent" = false, "updatedAt" = NOW()
       WHERE "tenantId" = $1
         AND "accountId" = $2
         AND "isCurrent" = true
         AND ("jobRunId" IS DISTINCT FROM $3)`,
      [tenantId, accountId, jobRunId],
    );
    return result.rowCount ?? 0;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/edge-writer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/jobs/discovery/services/edge-writer.ts apps/workers/src/jobs/discovery/__tests__/edge-writer.test.ts
git commit -m "feat(graph): add tenant-scoped edge writer with stale reconcile"
```

---

### Task 8: Wire extraction into the discovery scan

**Files:**
- Modify: `apps/workers/src/jobs/discovery/index.ts` (near the `writeResourcesToPg` call at line 121, and the `reconcileStaleResources` call at line 56)
- Test: `apps/workers/src/jobs/discovery/__tests__/handle-discovery-scan.test.ts`

**Interfaces:**
- Consumes: `extractEdges` (Task 6); `writeEdgesToPg`, `reconcileStaleEdges` (Task 7).
- Produces: no new exports — edges are written as a side effect of every scan.

- [ ] **Step 1: Read the surrounding code**

Read `apps/workers/src/jobs/discovery/index.ts` lines 40-135 to see the exact `try`/`catch` structure around the per-account scan and where `scanId` and `account.accountId` are in scope. Match that structure precisely — do not restructure it.

- [ ] **Step 2: Write a failing test asserting edges are written per account**

Add to `apps/workers/src/jobs/discovery/__tests__/handle-discovery-scan.test.ts`, following the mocking style already used in that file (mock `../services/edge-writer.js` alongside the existing `../services/pg-writer.js` mock):

```typescript
it('writes edges for each scanned account', async () => {
  // Arrange the scan to return one EC2 instance with a VpcId (see the existing
  // scanner mock in this file for the exact shape).
  await handleDiscoveryScan({ type: 'scan', tenantId: 'tenant-1', triggeredBy: 'cron' } as any);

  expect(writeEdgesToPg).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({ relation: 'in_vpc', toType: 'ec2_vpcs', toId: 'vpc-1' }),
    ]),
    'tenant-1',
    expect.any(String),
    expect.any(String),
    expect.any(String),
  );
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery/__tests__/handle-discovery-scan.test.ts -t 'writes edges'`
Expected: FAIL — `writeEdgesToPg` was not called.

- [ ] **Step 4: Add the imports**

In `apps/workers/src/jobs/discovery/index.ts`, after the existing pg-writer import (line 7):

```typescript
import { extractEdges } from './services/edge-extractor.js';
import { writeEdgesToPg, reconcileStaleEdges } from './services/edge-writer.js';
```

- [ ] **Step 5: Extract and write edges after resources are written**

Immediately after the `await writeResourcesToPg(...)` call (line 121):

```typescript
            // Edges must be derived here: rawData is not persisted, so this is the
            // only point at which the relationship data exists.
            const edges = extractEdges(result.resources);
            await writeEdgesToPg(edges, tenantId, account.accountId, account.regions[0] ?? 'us-east-1', scanId);
```

- [ ] **Step 6: Reconcile stale edges alongside stale resources**

Immediately after the `staleCount = await reconcileStaleResources(...)` call (line 56):

```typescript
        await reconcileStaleEdges(tenantId, accountId, scanId);
```

- [ ] **Step 7: Run the discovery suite**

Run: `cd apps/workers && bunx vitest run src/jobs/discovery`
Expected: PASS, including the new test.

- [ ] **Step 8: Verify end to end against a real scan**

```bash
cd apps/workers && bun run src/jobs/discovery/local-runner.ts
```

Then:

```bash
docker compose exec -T postgres psql -U postgres -d nucleus -c 'SELECT "fromType", relation, "toType", count(*) FROM resource_edges WHERE "isCurrent" GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 20;'
```

Expected: non-empty rows including `ec2_instances | in_vpc | ec2_vpcs` and, if the account has load balancers, `elbv2_target_groups | routes_to_instance | ec2_instances`. Record the actual output in the commit message.

- [ ] **Step 9: Commit**

```bash
git add apps/workers/src/jobs/discovery/index.ts apps/workers/src/jobs/discovery/__tests__/handle-discovery-scan.test.ts
git commit -m "feat(discovery): extract and persist resource edges during scan"
```

---

### Task 9: Traversal repository

**Files:**
- Create: `apps/web-ui/lib/db/repositories/resource-graph/interface.ts`
- Create: `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts`
- Modify: `apps/web-ui/lib/db/repository-factory.ts`
- Test: `apps/web-ui/tests/resource-graph/repository.test.ts`

**Interfaces:**
- Consumes: table from Task 1; `getTenantClient` from `@/lib/db/pg-config`.
- Produces:
  - `type GraphEdge = { fromType: string; fromId: string; relation: string; toType: string; toId: string; depth: number }`
  - `interface IResourceGraphRepository { getNeighbors(a): Promise<GraphEdge[]>; getBlastRadius(a): Promise<GraphEdge[]> }` where `a = { tenantId: string; resourceType: string; resourceId: string; depth?: number; limit?: number }`
  - `getResourceGraphRepository(): IResourceGraphRepository`

- [ ] **Step 1: Write the interface**

Create `apps/web-ui/lib/db/repositories/resource-graph/interface.ts`:

```typescript
export interface GraphEdge {
    fromType: string;
    fromId: string;
    relation: string;
    toType: string;
    toId: string;
    depth: number;
}

export interface GraphQueryArgs {
    tenantId: string;
    resourceType: string;
    resourceId: string;
    depth?: number;
    limit?: number;
}

export interface IResourceGraphRepository {
    // Edges in both directions within `depth` hops of the given resource.
    getNeighbors(args: GraphQueryArgs): Promise<GraphEdge[]>;
    // Resources that transitively depend ON the given resource (inbound walk):
    // "what breaks if this goes away".
    getBlastRadius(args: GraphQueryArgs): Promise<GraphEdge[]>;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/web-ui/tests/resource-graph/repository.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueryRawUnsafe = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/db/pg-config', () => ({
    getTenantClient: vi.fn(() => ({ $queryRawUnsafe: mockQueryRawUnsafe })),
}));

import { ResourceGraphPostgresRepository } from '@/lib/db/repositories/resource-graph/postgres';

describe('ResourceGraphPostgresRepository', () => {
    const repo = new ResourceGraphPostgresRepository();

    beforeEach(() => vi.clearAllMocks());

    it('binds tenantId as the first parameter on getNeighbors', async () => {
        await repo.getNeighbors({ tenantId: 't-1', resourceType: 'ec2_instances', resourceId: 'i-1' });

        const [sql, ...params] = mockQueryRawUnsafe.mock.calls[0];
        expect(sql).toContain('WITH RECURSIVE');
        expect(sql).toContain('"tenantId" = $1');
        expect(params[0]).toBe('t-1');
        expect(params[1]).toBe('ec2_instances');
        expect(params[2]).toBe('i-1');
    });

    it('walks inbound only for getBlastRadius', async () => {
        await repo.getBlastRadius({ tenantId: 't-1', resourceType: 'ec2_instances', resourceId: 'i-1' });

        const [sql] = mockQueryRawUnsafe.mock.calls[0];
        expect(sql).toContain('"toType" = $2');
        expect(sql).toContain('"toId" = $3');
    });

    it('clamps depth to 5 and limit to 500', async () => {
        await repo.getNeighbors({ tenantId: 't-1', resourceType: 'ec2_instances', resourceId: 'i-1', depth: 99, limit: 9999 });

        const params = mockQueryRawUnsafe.mock.calls[0].slice(1);
        expect(params).toContain(5);
        expect(params).toContain(500);
    });

    it('defaults depth to 1 for neighbors and 3 for blast radius', async () => {
        await repo.getNeighbors({ tenantId: 't-1', resourceType: 'ec2_instances', resourceId: 'i-1' });
        expect(mockQueryRawUnsafe.mock.calls[0].slice(1)).toContain(1);

        mockQueryRawUnsafe.mockClear();
        await repo.getBlastRadius({ tenantId: 't-1', resourceType: 'ec2_instances', resourceId: 'i-1' });
        expect(mockQueryRawUnsafe.mock.calls[0].slice(1)).toContain(3);
    });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd apps/web-ui && bunx vitest run tests/resource-graph/repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the repository**

Create `apps/web-ui/lib/db/repositories/resource-graph/postgres.ts`:

```typescript
/**
 * Resource dependency graph traversal.
 *
 * Multi-tenant safety: $queryRawUnsafe is NOT intercepted by the Prisma tenant
 * extension, so every query below binds "tenantId" = $1 explicitly.
 *
 * Cycle safety: the graph contains cycles (security groups reference each other).
 * The depth cap is the real guard; UNION additionally collapses repeated rows.
 */
import { getTenantClient } from '@/lib/db/pg-config';
import type { GraphEdge, GraphQueryArgs, IResourceGraphRepository } from './interface';

const MAX_DEPTH = 5;
const MAX_LIMIT = 500;

const clamp = (value: number, max: number) => Math.max(1, Math.min(value, max));

export class ResourceGraphPostgresRepository implements IResourceGraphRepository {
    async getNeighbors(args: GraphQueryArgs): Promise<GraphEdge[]> {
        const depth = clamp(args.depth ?? 1, MAX_DEPTH);
        const limit = clamp(args.limit ?? 100, MAX_LIMIT);

        const sql = `
            WITH RECURSIVE walk AS (
                SELECT "fromType", "fromId", relation, "toType", "toId", 1 AS depth
                FROM resource_edges
                WHERE "tenantId" = $1 AND "isCurrent" = true
                  AND (("fromType" = $2 AND "fromId" = $3) OR ("toType" = $2 AND "toId" = $3))
                UNION
                SELECT e."fromType", e."fromId", e.relation, e."toType", e."toId", w.depth + 1
                FROM resource_edges e
                JOIN walk w
                  ON (e."fromType" = w."toType"   AND e."fromId" = w."toId")
                  OR (e."toType"   = w."fromType" AND e."toId"   = w."fromId")
                WHERE e."tenantId" = $1 AND e."isCurrent" = true AND w.depth < $4
            )
            SELECT "fromType", "fromId", relation, "toType", "toId", depth
            FROM walk
            ORDER BY depth, "fromType", "fromId"
            LIMIT $5
        `;

        return getTenantClient(args.tenantId).$queryRawUnsafe<GraphEdge[]>(
            sql,
            args.tenantId,
            args.resourceType,
            args.resourceId,
            depth,
            limit,
        );
    }

    async getBlastRadius(args: GraphQueryArgs): Promise<GraphEdge[]> {
        const depth = clamp(args.depth ?? 3, MAX_DEPTH);
        const limit = clamp(args.limit ?? 200, MAX_LIMIT);

        // Inbound walk: start from edges pointing AT the resource, then find what
        // points at those dependents, and so on.
        const sql = `
            WITH RECURSIVE walk AS (
                SELECT "fromType", "fromId", relation, "toType", "toId", 1 AS depth
                FROM resource_edges
                WHERE "tenantId" = $1 AND "isCurrent" = true
                  AND "toType" = $2 AND "toId" = $3
                UNION
                SELECT e."fromType", e."fromId", e.relation, e."toType", e."toId", w.depth + 1
                FROM resource_edges e
                JOIN walk w ON e."toType" = w."fromType" AND e."toId" = w."fromId"
                WHERE e."tenantId" = $1 AND e."isCurrent" = true AND w.depth < $4
            )
            SELECT "fromType", "fromId", relation, "toType", "toId", depth
            FROM walk
            ORDER BY depth, "fromType", "fromId"
            LIMIT $5
        `;

        return getTenantClient(args.tenantId).$queryRawUnsafe<GraphEdge[]>(
            sql,
            args.tenantId,
            args.resourceType,
            args.resourceId,
            depth,
            limit,
        );
    }
}
```

- [ ] **Step 5: Register in the repository factory**

In `apps/web-ui/lib/db/repository-factory.ts`, add the type import beside the others:

```typescript
import type { IResourceGraphRepository } from './repositories/resource-graph/interface';
```

and the getter, following the established `require`-inside-function style:

```typescript
export function getResourceGraphRepository(): IResourceGraphRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ResourceGraphPostgresRepository } = require('./repositories/resource-graph/postgres');
    return new ResourceGraphPostgresRepository();
}
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/web-ui && bunx vitest run tests/resource-graph/repository.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Verify traversal against real data**

```bash
docker compose exec -T postgres psql -U postgres -d nucleus -c "WITH RECURSIVE walk AS (SELECT \"fromType\",\"fromId\",relation,\"toType\",\"toId\",1 AS depth FROM resource_edges WHERE \"isCurrent\" AND \"toType\"='ec2_instances' UNION SELECT e.\"fromType\",e.\"fromId\",e.relation,e.\"toType\",e.\"toId\",w.depth+1 FROM resource_edges e JOIN walk w ON e.\"toType\"=w.\"fromType\" AND e.\"toId\"=w.\"fromId\" WHERE e.\"isCurrent\" AND w.depth<3) SELECT depth, count(*) FROM walk GROUP BY 1 ORDER BY 1;"
```

Expected: the query terminates (proving the depth cap defeats the security-group cycles) and returns a row per depth level.

- [ ] **Step 8: Commit**

```bash
git add apps/web-ui/lib/db/repositories/resource-graph apps/web-ui/lib/db/repository-factory.ts apps/web-ui/tests/resource-graph
git commit -m "feat(graph): add resource graph traversal repository"
```

---

### Task 10: Agent tools

**Files:**
- Create: `apps/web-ui/lib/agent/resource-graph-tool.ts`
- Test: `apps/web-ui/tests/resource-graph/tools.test.ts`

**Interfaces:**
- Consumes: `getResourceGraphRepository` (Task 9).
- Produces: `createGetResourceNeighborsTool(tenantId: string)` and `createGetBlastRadiusTool(tenantId: string)`, both returning LangChain tools whose handlers resolve to a JSON string.

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/tests/resource-graph/tools.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetNeighbors = vi.fn().mockResolvedValue([]);
const mockGetBlastRadius = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/db/repository-factory', () => ({
    getResourceGraphRepository: () => ({
        getNeighbors: mockGetNeighbors,
        getBlastRadius: mockGetBlastRadius,
    }),
}));

import { createGetResourceNeighborsTool, createGetBlastRadiusTool } from '@/lib/agent/resource-graph-tool';

describe('resource graph agent tools', () => {
    beforeEach(() => vi.clearAllMocks());

    it('binds the tenantId from construction, not from model input', async () => {
        const tool = createGetResourceNeighborsTool('tenant-1');
        await tool.invoke({ resourceType: 'ec2_instances', resourceId: 'i-1' });

        expect(mockGetNeighbors).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
    });

    it('does not expose tenantId in the tool schema', () => {
        const tool = createGetResourceNeighborsTool('tenant-1');
        expect(JSON.stringify(tool.schema)).not.toContain('tenantId');
    });

    it('returns a JSON string with a count and the edges', async () => {
        mockGetNeighbors.mockResolvedValueOnce([
            { fromType: 'ec2_instances', fromId: 'i-1', relation: 'in_vpc', toType: 'ec2_vpcs', toId: 'vpc-1', depth: 1 },
        ]);

        const tool = createGetResourceNeighborsTool('tenant-1');
        const parsed = JSON.parse(await tool.invoke({ resourceType: 'ec2_instances', resourceId: 'i-1' }));

        expect(parsed.count).toBe(1);
        expect(parsed.edges[0].relation).toBe('in_vpc');
    });

    it('reports explicitly when a resource has no edges', async () => {
        const tool = createGetResourceNeighborsTool('tenant-1');
        const parsed = JSON.parse(await tool.invoke({ resourceType: 'ec2_instances', resourceId: 'i-unknown' }));

        expect(parsed.count).toBe(0);
        expect(parsed.note).toContain('No edges');
    });

    it('blast radius groups dependents by depth', async () => {
        mockGetBlastRadius.mockResolvedValueOnce([
            { fromType: 'elbv2_target_groups', fromId: 'arn:tg/1', relation: 'routes_to_instance', toType: 'ec2_instances', toId: 'i-1', depth: 1 },
            { fromType: 'elbv2_load_balancers', fromId: 'arn:lb/1', relation: 'attached_to_load_balancer', toType: 'elbv2_target_groups', toId: 'arn:tg/1', depth: 2 },
        ]);

        const tool = createGetBlastRadiusTool('tenant-1');
        const parsed = JSON.parse(await tool.invoke({ resourceType: 'ec2_instances', resourceId: 'i-1' }));

        expect(parsed.dependentCount).toBe(2);
        expect(parsed.byDepth['1']).toHaveLength(1);
        expect(parsed.byDepth['2']).toHaveLength(1);
    });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/web-ui && bunx vitest run tests/resource-graph/tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tools**

Create `apps/web-ui/lib/agent/resource-graph-tool.ts`:

```typescript
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getResourceGraphRepository } from '@/lib/db/repository-factory';

/**
 * Resource dependency graph tools. Both are read-only and bound to a tenantId at
 * construction — the model never supplies a tenantId, so cross-tenant reads are
 * impossible by construction (mirrors createGetRightSizingRecommendationsTool).
 */

const graphInput = z.object({
    resourceType: z
        .string()
        .describe('Discovered resource type, e.g. ec2_instances, rds_db_instances, elbv2_load_balancers, ec2_security_groups'),
    resourceId: z
        .string()
        .describe('The resource id as stored in inventory, e.g. i-0abc123, prod-db, or a full ARN for load balancers and target groups'),
    depth: z.number().optional().describe('Hops to traverse (1-5)'),
});

export function createGetResourceNeighborsTool(tenantId: string) {
    return tool(
        async (input: { resourceType: string; resourceId: string; depth?: number }) => {
            const edges = await getResourceGraphRepository().getNeighbors({
                tenantId,
                resourceType: input.resourceType,
                resourceId: input.resourceId,
                depth: input.depth,
            });

            return JSON.stringify({
                resource: `${input.resourceType}/${input.resourceId}`,
                count: edges.length,
                edges,
                ...(edges.length === 0
                    ? { note: 'No edges found. The resource may not be discovered yet, or its type emits no relationships.' }
                    : {}),
            });
        },
        {
            name: 'get_resource_neighbors',
            description:
                'Get the directly connected AWS resources for one discovered resource — its VPC, subnets, security groups, volumes, attached load balancers, IAM role, KMS key, and so on. ' +
                'Use this instead of guessing how resources relate, and instead of running AWS CLI describe calls, whenever you need to know what a resource is connected to. Read-only.',
            schema: graphInput,
        },
    );
}

export function createGetBlastRadiusTool(tenantId: string) {
    return tool(
        async (input: { resourceType: string; resourceId: string; depth?: number }) => {
            const edges = await getResourceGraphRepository().getBlastRadius({
                tenantId,
                resourceType: input.resourceType,
                resourceId: input.resourceId,
                depth: input.depth,
            });

            const byDepth: Record<string, typeof edges> = {};
            for (const edge of edges) {
                const key = String(edge.depth);
                (byDepth[key] ||= []).push(edge);
            }

            return JSON.stringify({
                resource: `${input.resourceType}/${input.resourceId}`,
                dependentCount: edges.length,
                byDepth,
                ...(edges.length === 0
                    ? { note: 'Nothing depends on this resource according to the discovered graph.' }
                    : {}),
            });
        },
        {
            name: 'get_blast_radius',
            description:
                'Find everything that transitively DEPENDS ON a discovered AWS resource — what would be affected if it were stopped, deleted, or degraded. ' +
                'Always call this before recommending or performing a stop, delete, or resize on a resource, and when root-causing an incident to find upstream dependents. ' +
                'Results are grouped by hop distance. Read-only.',
            schema: graphInput,
        },
    );
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web-ui && bunx vitest run tests/resource-graph/tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/resource-graph-tool.ts apps/web-ui/tests/resource-graph/tools.test.ts
git commit -m "feat(agent): add resource graph neighbor and blast radius tools"
```

---

### Task 11: Register the tools and steer the agent

**Files:**
- Modify: `apps/web-ui/lib/agent/model-factory.ts` (import block ~line 26, tool array ~line 271)
- Modify: `apps/web-ui/lib/agent/prompt-templates.ts`

**Interfaces:**
- Consumes: `createGetResourceNeighborsTool`, `createGetBlastRadiusTool` (Task 10).
- Produces: both tools present in every assembled agent tool list; prompt guidance instructing the agent to prefer the graph.

- [ ] **Step 1: Import the tool factories**

In `apps/web-ui/lib/agent/model-factory.ts`, beside the existing `right-sizing-tool` import (line 26):

```typescript
import { createGetResourceNeighborsTool, createGetBlastRadiusTool } from "./resource-graph-tool";
```

- [ ] **Step 2: Register them in the tool array**

After `createGetRightSizingRecommendationsTool(effectiveTenantId),` (line 271):

```typescript
        createGetResourceNeighborsTool(effectiveTenantId),
        createGetBlastRadiusTool(effectiveTenantId),
```

- [ ] **Step 3: Add prompt guidance**

Read `apps/web-ui/lib/agent/prompt-templates.ts` and locate `CORE_PRINCIPLES`. Append this bullet to it, matching the surrounding formatting exactly:

```
- Resource relationships come from the dependency graph, not from guesswork. When you need to know what a resource is connected to, call get_resource_neighbors rather than inferring from names, tags, or AWS CLI describe output. Before recommending or performing any stop, delete, or resize, call get_blast_radius first and state what depends on the resource. If the graph returns no edges, say so explicitly rather than assuming the resource is isolated.
```

- [ ] **Step 4: Verify the tools are registered**

Run: `cd apps/web-ui && bunx vitest run tests/` and confirm no existing agent test breaks on the changed tool count. If a test asserts an exact tool count, update that expectation.

- [ ] **Step 5: Typecheck and lint**

```bash
cd apps/web-ui && bunx tsc --noEmit && bun run lint
```

Expected: no errors.

- [ ] **Step 6: Verify in the running app**

```bash
docker compose up -d postgres && bun run dev
```

In Mission Control, ask: `What depends on <an instance id from your inventory>?` Confirm from the tool-call trace that `get_blast_radius` is invoked and its result is reflected in the answer. If the agent answers without calling the tool, strengthen the prompt bullet and retry.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/agent/model-factory.ts apps/web-ui/lib/agent/prompt-templates.ts
git commit -m "feat(agent): register graph tools and steer the agent to use them"
```

---

### Task 12: Document the design and the IAM requirement

The target-group scanners need two permissions that a customer's existing cross-account read role may not grant. That role is created customer-side and is not defined in this repo, so this is a documentation deliverable.

**Files:**
- Create: `docs/RESOURCE_GRAPH_ARCHITECTURE.md`
- Modify: `CLAUDE.md` (the Workers section resource list)

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Write the architecture doc**

Create `docs/RESOURCE_GRAPH_ARCHITECTURE.md` covering:

- **Why**: a flat `inventory_resources` table cannot answer blast-radius or root-cause questions; edges arrive in every describe response and were previously discarded.
- **Approach**: edges derived deterministically from `rawData` during the scan — no LLM extraction, no graph database. Traversal via Postgres recursive CTEs.
- **Data model**: the `resource_edges` columns from Task 1, and the explicit decision to have **no** FK to `inventory_resources` (dangling edges are valid).
- **Coverage**: 23 source types in `EDGE_SPECS` plus 2 custom derivers; ~11 types are inbound-only by nature (`ec2_vpcs`, `kms_keys`, `sns_topics`, `sqs_queues`, `iam_roles`, `iam_users`, `s3_buckets`, `acm_certificates`, `wafv2_web_acls`, `ec2_transit_gateways`, `ecs_clusters`).
- **Known limitations**, copied from this plan's "Known Pre-Existing Issues": `ec2_addresses` excluded (wrong `resourceId`); `cloudfront → wafv2` omitted (ID convention mismatch); CloudFront ALB origins not derivable from hostname; EFS mount targets, EventBridge rule targets, API Gateway integrations, CodePipeline stages and Backup plan selections all need additional API calls and are out of scope.
- **Cycle safety**: security groups reference each other; depth is capped at 5 and every traversal is `LIMIT`ed.
- **Multi-tenancy**: raw SQL on both sides is not tenant-intercepted; every read and write binds `tenantId` explicitly.
- **Required IAM permissions on the customer cross-account read role**, called out prominently:

```
elasticloadbalancing:DescribeTargetGroups
elasticloadbalancing:DescribeTargetHealth
```

Note that accounts using the AWS-managed `ReadOnlyAccess` or `SecurityAudit` policy already have both; accounts with a hand-rolled least-privilege policy must add them, and that without them target-group scanning degrades gracefully (`_targetHealth` is `[]`, a warning is logged, the scan still succeeds) but the load-balancer → instance edge is silently absent.

- [ ] **Step 2: Update CLAUDE.md**

In the **Workers (pg-boss)** section, extend the `discovery/` bullet to mention edge extraction:

```
- `workers/src/jobs/discovery/` — multi-account resource scanning; also derives the resource dependency graph (`resource_edges`) from raw describe responses via `services/edge-spec.ts` + `services/edge-extractor.ts`. Web-ui side: `lib/db/repositories/resource-graph/`, agent tools `get_resource_neighbors` / `get_blast_radius`. See `docs/RESOURCE_GRAPH_ARCHITECTURE.md`.
```

- [ ] **Step 3: Run the full suite one last time**

```bash
bun run test
```

Expected: all projects pass. Record the summary line.

- [ ] **Step 4: Commit**

```bash
git add docs/RESOURCE_GRAPH_ARCHITECTURE.md CLAUDE.md
git commit -m "docs(graph): document resource dependency graph design and IAM needs"
```

---

## Self-Review

**Spec coverage.** Agent-first (Tasks 10-11, no UI) ✓. Six named core types plus full Tier A coverage (Task 4) ✓. Target groups included per decision (Task 2) ✓. Edges built inside the scan, as forced by `rawData` not being persisted (Task 8) ✓. Declarative spec so extending coverage is config, not code (Task 4) ✓. Postgres recursive CTEs, no graph DB (Task 9) ✓. Manual tenant scoping throughout (Tasks 7, 9) ✓. No FK to `inventory_resources` (Task 1) ✓.

**Type consistency.** `ResourceEdge` (worker-side, no `depth`) and `GraphEdge` (web-ui, with `depth`) are deliberately distinct types across a process boundary — they are not the same object and are never assigned to one another. `EdgeSpec.when` is defined in Task 3 and consumed in Tasks 4 and 6. `CUSTOM_DERIVERS` signature `(raw, fromId) => ResourceEdge[]` matches its Task 6 call site. `writeEdgesToPg`'s five-parameter signature matches the Task 8 call.

**Two deviations from the ideal, called out rather than hidden:**

1. **Task 2 modifies shared ID-extraction logic.** Adding `TargetGroupArn` to `idKeys` changes behaviour for a type nothing currently scans, so the blast radius is nil — but it is a shared array, and Step 4 requires the whole existing scanner suite to stay green.
2. **Task 8's test is described rather than fully written.** The exact mock arrangement depends on the existing structure of `handle-discovery-scan.test.ts`, which the implementer must read first (Step 1). Every other test in this plan is complete and runnable as written.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-10-resource-dependency-graph.md`.

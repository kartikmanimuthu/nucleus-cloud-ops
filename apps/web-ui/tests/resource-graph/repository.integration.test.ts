// Integration tests for ResourceGraphPostgresRepository against a REAL PostgreSQL.
//
// The traversal is recursive SQL. A mocked Prisma client can only assert that some
// string was sent to the database — never that the walk returns the right resources.
// repository.test.ts does the former; these do the latter.
//
// $queryRawUnsafe is NOT intercepted by the getTenantClient extension, so the literal
// `"tenantId" = $1` in each query is the only tenant guard. That is asserted here too.
//
//   docker compose up -d postgres
//   cd apps/web-ui && DATABASE_URL='postgresql://nucleus:nucleus_dev@localhost:5432/nucleus' \
//     bunx vitest run tests/resource-graph/repository.integration.test.ts
//
// Skips itself when DATABASE_URL is unset so it never breaks CI without a database.
//
// Heads up: Bun auto-loads the root .env, so a plain `bun run test` runs this against
// whatever DATABASE_URL that file names — which on this team is a SHARED dev Postgres.
// Every row written here is namespaced to the two test tenant ids below and deleted in
// afterAll, so a shared database sees nothing but those; point DATABASE_URL at the local
// container if you would rather it stay entirely local.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPrismaClient, disconnectPrisma } from '@/lib/db/pg-config';
import { ResourceGraphPostgresRepository } from '@/lib/db/repositories/resource-graph/postgres';
import { STRUCTURAL_TYPES } from '@/lib/resource-graph/graph-constants';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const TENANT = 'test-resource-graph-integration';
const OTHER_TENANT = 'test-resource-graph-integration-other';

// Hand-verified fixture graph. Directions match what discovery actually emits.
//
//   i-1      --in_vpc-->                      vpc-1
//   i-1      --in_subnet-->                   subnet-1
//   i-1      --uses_security_group-->         sg-1
//   arn:tg   --routes_to_instance-->          i-1
//   vol-1    --attached_to-->                 i-1
//   arn:tg   --attached_to_load_balancer-->   arn:lb
//   asg-1    --registers_with_target_group--> arn:tg
//   arn:lb   --in_vpc-->                      vpc-1
//   subnet-1 --in_vpc-->                      vpc-1
// fromType, fromId, relation, toType, toId, and optionally region (default us-east-1).
type EdgeRow = [string, string, string, string, string, string?];

const EDGES: EdgeRow[] = [
    ['ec2_instances', 'i-1', 'in_vpc', 'ec2_vpcs', 'vpc-1'],
    ['ec2_instances', 'i-1', 'in_subnet', 'ec2_subnets', 'subnet-1'],
    ['ec2_instances', 'i-1', 'uses_security_group', 'ec2_security_groups', 'sg-1'],
    ['elbv2_target_groups', 'arn:tg', 'routes_to_instance', 'ec2_instances', 'i-1'],
    ['ec2_volumes', 'vol-1', 'attached_to', 'ec2_instances', 'i-1'],
    ['elbv2_target_groups', 'arn:tg', 'attached_to_load_balancer', 'elbv2_load_balancers', 'arn:lb'],
    ['autoscaling_auto_scaling_groups', 'asg-1', 'registers_with_target_group', 'elbv2_target_groups', 'arn:tg', 'eu-west-1'],
    ['elbv2_load_balancers', 'arn:lb', 'in_vpc', 'ec2_vpcs', 'vpc-1'],
    ['ec2_subnets', 'subnet-1', 'in_vpc', 'ec2_vpcs', 'vpc-1'],
];

const key = (e: { fromId: string; relation: string; toId: string }) =>
    `${e.fromId}|${e.relation}|${e.toId}`;

async function seed(tenantId: string, rows: EdgeRow[], isCurrent = true) {
    const db = getPrismaClient();
    for (const [i, [fromType, fromId, relation, toType, toId, region]] of rows.entries()) {
        await db.$executeRawUnsafe(
            `INSERT INTO resource_edges
               (id, "tenantId", "accountId", region, "fromType", "fromId", relation,
                "toType", "toId", "isCurrent", "updatedAt")
             VALUES ($1, $2, 'acc-1', $9, $3, $4, $5, $6, $7, $8, NOW())`,
            `${tenantId}-${i}-${isCurrent}`,
            tenantId,
            fromType,
            fromId,
            relation,
            toType,
            toId,
            isCurrent,
            region ?? 'us-east-1',
        );
    }
}

// resolveResourceType reads inventory_resources, so that table needs rows too.
async function seedInventory() {
    const db = getPrismaClient();
    const rows: Array<[string, string, string, boolean]> = [
        [TENANT, 'i-resolve-me', 'ec2_instances', true],
        [TENANT, 'i-stale-inventory', 'ec2_instances', false],
        [OTHER_TENANT, 'i-other-tenant-only', 'ec2_instances', true],
    ];
    for (const [tenantId, resourceId, resourceType, isCurrent] of rows) {
        await db.$executeRawUnsafe(
            `INSERT INTO inventory_resources
               (id, "tenantId", "accountId", region, "resourceType", "resourceId", "isCurrent", "updatedAt")
             VALUES ($1, $2, 'acc-1', 'us-east-1', $3, $4, $5, NOW())`,
            `${tenantId}-inv-${resourceId}`,
            tenantId,
            resourceType,
            resourceId,
            isCurrent,
        );
    }
}

// getSeed and queryGraph read inventory_resources and resource_edges together, so they
// need an account whose nodes exist in BOTH. acc-1 must stay half-seeded: its dangling
// edges are what the exists:false tests assert.
const CANVAS_ACCOUNT = 'acc-2';

async function seedCanvas() {
    const db = getPrismaClient();
    const nodes: Array<[string, string]> = [
        ['ec2_vpcs', 'canvas-vpc-1'],
        ['ec2_subnets', 'canvas-subnet-1'],
        ['ec2_instances', 'canvas-i-1'],
        ['elbv2_load_balancers', 'canvas-lb-1'],
        ['ec2_volumes', 'canvas-vol-1'],
        ['iam_roles', 'canvas-role-1'],
        ['ssm_parameters', 'canvas-ssm-1'],
    ];
    for (const [resourceType, resourceId] of nodes) {
        await db.$executeRawUnsafe(
            `INSERT INTO inventory_resources
               (id, "tenantId", "accountId", region, "resourceType", "resourceId", "isCurrent", "updatedAt")
             VALUES ($1, $2, '${CANVAS_ACCOUNT}', 'us-east-1', $3, $4, true, NOW())`,
            `${TENANT}-canvas-${resourceId}`,
            TENANT,
            resourceType,
            resourceId,
        );
    }

    const edges: Array<[string, string, string, string, string]> = [
        ['ec2_instances', 'canvas-i-1', 'in_vpc', 'ec2_vpcs', 'canvas-vpc-1'],
        ['ec2_instances', 'canvas-i-1', 'in_subnet', 'ec2_subnets', 'canvas-subnet-1'],
        ['ec2_subnets', 'canvas-subnet-1', 'in_vpc', 'ec2_vpcs', 'canvas-vpc-1'],
        ['elbv2_load_balancers', 'canvas-lb-1', 'in_vpc', 'ec2_vpcs', 'canvas-vpc-1'],
        ['ec2_volumes', 'canvas-vol-1', 'attached_to', 'ec2_instances', 'canvas-i-1'],
        ['ec2_instances', 'canvas-i-1', 'uses_iam_role', 'iam_roles', 'canvas-role-1'],
        ['ssm_parameters', 'canvas-ssm-1', 'in_vpc', 'ec2_vpcs', 'canvas-vpc-1'],
    ];
    for (const [i, [fromType, fromId, relation, toType, toId]] of edges.entries()) {
        await db.$executeRawUnsafe(
            `INSERT INTO resource_edges
               (id, "tenantId", "accountId", region, "fromType", "fromId", relation,
                "toType", "toId", "isCurrent", "updatedAt")
             VALUES ($1, $2, '${CANVAS_ACCOUNT}', 'us-east-1', $3, $4, $5, $6, $7, true, NOW())`,
            `${TENANT}-canvas-edge-${i}`,
            TENANT,
            fromType,
            fromId,
            relation,
            toType,
            toId,
        );
    }
}

// The same resourceType+resourceId under a second account: real estates do this constantly
// (one Control Tower lambda spans 95 accounts). Without deduped node keys the joins in
// edgesAmong multiply instead of matching.
const DUPLICATE_ACCOUNT = 'acc-3';

async function seedDuplicateAccount() {
    const db = getPrismaClient();
    for (const [resourceType, resourceId] of [['ec2_vpcs', 'canvas-vpc-1'], ['ec2_instances', 'canvas-i-1']]) {
        await db.$executeRawUnsafe(
            `INSERT INTO inventory_resources
               (id, "tenantId", "accountId", region, "resourceType", "resourceId", "isCurrent", "updatedAt")
             VALUES ($1, $2, '${DUPLICATE_ACCOUNT}', 'us-east-1', $3, $4, true, NOW())`,
            `${TENANT}-dup-${resourceId}`,
            TENANT,
            resourceType,
            resourceId,
        );
    }
    await db.$executeRawUnsafe(
        `INSERT INTO resource_edges
           (id, "tenantId", "accountId", region, "fromType", "fromId", relation,
            "toType", "toId", "isCurrent", "updatedAt")
         VALUES ($1, $2, '${DUPLICATE_ACCOUNT}', 'us-east-1',
                 'ec2_instances', 'canvas-i-1', 'in_vpc', 'ec2_vpcs', 'canvas-vpc-1', true, NOW())`,
        `${TENANT}-dup-edge-0`,
        TENANT,
    );
}

// A third account whose only purpose is exercising cross-account edge targets, kept
// separate from CANVAS_ACCOUNT so its pinned node/edge counts never move.
const CROSS_ACCOUNT = 'acc-5';
const EXTERNAL_ACCOUNT = 'acc-ext';

async function seedCrossAccount() {
    const db = getPrismaClient();

    await db.$executeRawUnsafe(
        `INSERT INTO inventory_resources
           (id, "tenantId", "accountId", region, "resourceType", "resourceId", "isCurrent", "updatedAt")
         VALUES ($1, $2, '${CROSS_ACCOUNT}', 'us-east-1', 'ec2_instances', 'cross-i-1', true, NOW())`,
        `${TENANT}-cross-i-1`,
        TENANT,
    );

    // The real cross-account reference: a resource this account owns points at a KMS key
    // that inventory places under a different account, for the same tenant.
    await db.$executeRawUnsafe(
        `INSERT INTO inventory_resources
           (id, "tenantId", "accountId", region, "resourceType", "resourceId", "isCurrent", "updatedAt")
         VALUES ($1, $2, '${EXTERNAL_ACCOUNT}', 'us-east-1', 'kms_keys', 'kms-shared-1', true, NOW())`,
        `${TENANT}-ext-kms-shared-1`,
        TENANT,
    );
    await db.$executeRawUnsafe(
        `INSERT INTO resource_edges
           (id, "tenantId", "accountId", region, "fromType", "fromId", relation,
            "toType", "toId", "isCurrent", "updatedAt")
         VALUES ($1, $2, '${CROSS_ACCOUNT}', 'us-east-1',
                 'ec2_instances', 'cross-i-1', 'encrypted_with', 'kms_keys', 'kms-shared-1', true, NOW())`,
        `${TENANT}-cross-edge-shared-kms`,
        TENANT,
    );

    // The tenant-isolation trap: an edge to the same-shaped id, but the only inventory row
    // for it lives under OTHER_TENANT. It must never be resolved as an external node here.
    await db.$executeRawUnsafe(
        `INSERT INTO inventory_resources
           (id, "tenantId", "accountId", region, "resourceType", "resourceId", "isCurrent", "updatedAt")
         VALUES ($1, $2, '${EXTERNAL_ACCOUNT}', 'us-east-1', 'kms_keys', 'kms-tenant-leak-1', true, NOW())`,
        `${OTHER_TENANT}-ext-kms-leak-1`,
        OTHER_TENANT,
    );
    await db.$executeRawUnsafe(
        `INSERT INTO resource_edges
           (id, "tenantId", "accountId", region, "fromType", "fromId", relation,
            "toType", "toId", "isCurrent", "updatedAt")
         VALUES ($1, $2, '${CROSS_ACCOUNT}', 'us-east-1',
                 'ec2_instances', 'cross-i-1', 'encrypted_with', 'kms_keys', 'kms-tenant-leak-1', true, NOW())`,
        `${TENANT}-cross-edge-tenant-leak`,
        TENANT,
    );
}

describe.skipIf(!HAS_DB)('ResourceGraphPostgresRepository (real Postgres)', () => {
    const repo = new ResourceGraphPostgresRepository();

    beforeAll(async () => {
        const db = getPrismaClient();
        await db.$executeRawUnsafe('DELETE FROM resource_edges WHERE "tenantId" = ANY($1)', [
            TENANT,
            OTHER_TENANT,
        ]);
        await db.$executeRawUnsafe('DELETE FROM inventory_resources WHERE "tenantId" = ANY($1)', [
            TENANT,
            OTHER_TENANT,
        ]);
        await seed(TENANT, EDGES);
        // Same anchor resource in a different tenant — must never leak into results.
        await seed(OTHER_TENANT, [['ec2_instances', 'i-1', 'in_vpc', 'ec2_vpcs', 'vpc-leaked']]);
        // A superseded edge on the anchor — must be filtered by isCurrent.
        await seed(TENANT, [['ec2_instances', 'i-1', 'in_subnet', 'ec2_subnets', 'subnet-stale']], false);
        await seedInventory();
        await seedCanvas();
        await seedDuplicateAccount();
        await seedCrossAccount();
    });

    afterAll(async () => {
        const db = getPrismaClient();
        await db.$executeRawUnsafe('DELETE FROM resource_edges WHERE "tenantId" = ANY($1)', [
            TENANT,
            OTHER_TENANT,
        ]);
        await db.$executeRawUnsafe('DELETE FROM inventory_resources WHERE "tenantId" = ANY($1)', [
            TENANT,
            OTHER_TENANT,
        ]);
        await disconnectPrisma();
    });

    describe('getNeighbors', () => {
        it('returns every edge touching the resource at depth 1, in either direction', async () => {
            const edges = await repo.getNeighbors({
                tenantId: TENANT,
                resourceType: 'ec2_instances',
                resourceId: 'i-1',
                depth: 1,
            });

            expect(edges.map(key).sort()).toEqual(
                [
                    'i-1|in_vpc|vpc-1',
                    'i-1|in_subnet|subnet-1',
                    'i-1|uses_security_group|sg-1',
                    'arn:tg|routes_to_instance|i-1',
                    'vol-1|attached_to|i-1',
                ].sort(),
            );
        });

        it('reaches the load balancer two hops out through the target group', async () => {
            const edges = await repo.getNeighbors({
                tenantId: TENANT,
                resourceType: 'ec2_instances',
                resourceId: 'i-1',
                depth: 2,
            });

            const keys = edges.map(key);
            // arn:tg is an inbound neighbour of i-1; the walk must be able to continue
            // outward from it, otherwise the ALB behind the target group is invisible.
            expect(keys).toContain('arn:tg|attached_to_load_balancer|arn:lb');
            expect(keys).toContain('arn:lb|in_vpc|vpc-1');
        });

        it('returns the full undirected two-hop closure exactly once per edge', async () => {
            const edges = await repo.getNeighbors({
                tenantId: TENANT,
                resourceType: 'ec2_instances',
                resourceId: 'i-1',
                depth: 2,
            });

            const keys = edges.map(key);
            expect(new Set(keys).size, 'the same edge must not be returned at several depths').toBe(keys.length);
            expect(keys.sort()).toEqual(EDGES.map(([, f, r, , t]) => `${f}|${r}|${t}`).sort());
        });

        it('reports each edge with its own region', async () => {
            const edges = await repo.getNeighbors({
                tenantId: TENANT,
                resourceType: 'ec2_instances',
                resourceId: 'i-1',
                depth: 2,
            });

            const byKey = new Map(edges.map((e) => [key(e), e.region]));
            expect(byKey.get('asg-1|registers_with_target_group|arn:tg')).toBe('eu-west-1');
            expect(byKey.get('i-1|in_vpc|vpc-1')).toBe('us-east-1');
        });

        it('excludes superseded edges and other tenants', async () => {
            const edges = await repo.getNeighbors({
                tenantId: TENANT,
                resourceType: 'ec2_instances',
                resourceId: 'i-1',
                depth: 3,
            });

            const toIds = edges.map((e) => e.toId);
            expect(toIds).not.toContain('subnet-stale');
            expect(toIds).not.toContain('vpc-leaked');
        });
    });

    describe('resolveResourceType', () => {
        it('returns discovery\'s internal type for a resource id', async () => {
            const type = await repo.resolveResourceType({ tenantId: TENANT, resourceId: 'i-resolve-me' });
            expect(type).toBe('ec2_instances');
        });

        it('returns null for an id this tenant does not have', async () => {
            const type = await repo.resolveResourceType({ tenantId: TENANT, resourceId: 'i-does-not-exist' });
            expect(type).toBeNull();
        });

        it('does not resolve another tenant\'s resource', async () => {
            const type = await repo.resolveResourceType({ tenantId: OTHER_TENANT, resourceId: 'i-resolve-me' });
            expect(type).toBeNull();
        });

        it('ignores superseded inventory rows', async () => {
            const type = await repo.resolveResourceType({ tenantId: TENANT, resourceId: 'i-stale-inventory' });
            expect(type).toBeNull();
        });
    });

    describe('getResourceDependencies', () => {
        it('splits inbound and outbound at depth 1', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1',
            });

            expect(r.dependents.edges.map((e) => e.relation).sort())
                .toEqual(['attached_to', 'routes_to_instance']);
            expect(r.dependsOn.edges.map((e) => e.relation).sort())
                .toEqual(['in_subnet', 'in_vpc', 'uses_security_group']);
        });

        it('enriches the far endpoint from inventory', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-resolve-me',
            });
            const all = [...r.dependents.edges, ...r.dependsOn.edges];
            // i-resolve-me has an inventory row; its edges' far ends do not.
            expect(all.every((e) => e.other.exists === false)).toBe(true);
        });

        it('marks a far endpoint absent from inventory as exists:false', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1',
            });
            const vpc = r.dependsOn.edges.find((e) => e.other.resourceId === 'vpc-1');
            expect(vpc?.other.exists).toBe(false);
            expect(vpc?.other.name).toBeNull();
        });

        it('reports pre-limit totals, not row counts', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1', limit: 1,
            });

            expect(r.dependsOn.edges).toHaveLength(1);
            expect(r.dependsOn.total).toBe(3);
            expect(r.dependsOn.truncated).toBe(true);
        });

        it('caps each direction independently so one cannot starve the other', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1', limit: 1,
            });

            expect(r.dependents.edges).toHaveLength(1);
            expect(r.dependsOn.edges).toHaveLength(1);
        });

        it('does not return another tenant\'s edges', async () => {
            const r = await repo.getResourceDependencies({
                tenantId: OTHER_TENANT, resourceType: 'ec2_instances', resourceId: 'i-1',
            });
            expect(r.dependsOn.edges.map((e) => e.other.resourceId)).toEqual(['vpc-leaked']);
        });

        it('does not enrich from another tenant\'s inventory', async () => {
            // OTHER_TENANT has inventory row i-other-tenant-only; TENANT must not see it.
            const r = await repo.getResourceDependencies({
                tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1',
            });
            expect(r.dependents.edges.every((e) => e.other.accountId === null
                || e.other.accountId === 'acc-1')).toBe(true);
        });

        it('returns AWS-managed KMS edges unlike expand; observation edges appear in both', async () => {
            const db = getPrismaClient();
            await db.$executeRawUnsafe(
                `INSERT INTO resource_edges
                   (id, "tenantId", "accountId", region, "fromType", "fromId", relation,
                    "toType", "toId", "isCurrent", "updatedAt")
                 VALUES ($1, $2, 'acc-1', 'us-east-1', $3, $4, $5, $6, $7, true, NOW())`,
                `${TENANT}-monitors-edge`, TENANT,
                'cloudwatch_alarms', 'alarm-x', 'monitors', 'ec2_instances', 'i-1',
            );
            await db.$executeRawUnsafe(
                `INSERT INTO resource_edges
                   (id, "tenantId", "accountId", region, "fromType", "fromId", relation,
                    "toType", "toId", "isCurrent", "updatedAt")
                 VALUES ($1, $2, 'acc-1', 'us-east-1', $3, $4, $5, $6, $7, true, NOW())`,
                `${TENANT}-encrypted-with-edge`, TENANT,
                'ec2_instances', 'i-1', 'encrypted_with', 'kms_keys', 'alias/aws/ebs',
            );

            try {
                const deps = await repo.getResourceDependencies({
                    tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1',
                });
                expect(deps.dependents.edges.some((e) => e.relation === 'monitors'
                    && e.other.resourceId === 'alarm-x')).toBe(true);
                expect(deps.dependsOn.edges.some((e) => e.relation === 'encrypted_with'
                    && e.other.resourceId === 'alias/aws/ebs')).toBe(true);

                const expanded = await repo.expand({
                    tenantId: TENANT, resourceType: 'ec2_instances', resourceId: 'i-1',
                });
                expect(expanded.dependents.edges.some((e) => e.relation === 'monitors')).toBe(true);
                expect(expanded.dependsOn.edges.some((e) => e.relation === 'encrypted_with')).toBe(false);
            } finally {
                await db.$executeRawUnsafe('DELETE FROM resource_edges WHERE id = ANY($1)', [
                    `${TENANT}-monitors-edge`,
                    `${TENANT}-encrypted-with-edge`,
                ]);
            }
        });
    });

    describe('getBlastRadius', () => {
        it('walks inbound only, and reports hop distance', async () => {
            const edges = await repo.getBlastRadius({
                tenantId: TENANT,
                resourceType: 'ec2_instances',
                resourceId: 'i-1',
                depth: 3,
            });

            expect(edges.map((e) => `${key(e)}@${e.depth}`).sort()).toEqual(
                [
                    'arn:tg|routes_to_instance|i-1@1',
                    'vol-1|attached_to|i-1@1',
                    'asg-1|registers_with_target_group|arn:tg@2',
                ].sort(),
            );
        });

        it('reports each dependent edge with its own region', async () => {
            const edges = await repo.getBlastRadius({
                tenantId: TENANT,
                resourceType: 'ec2_instances',
                resourceId: 'i-1',
                depth: 3,
            });

            const byKey = new Map(edges.map((e) => [key(e), e.region]));
            expect(byKey.get('asg-1|registers_with_target_group|arn:tg')).toBe('eu-west-1');
            expect(byKey.get('vol-1|attached_to|i-1')).toBe('us-east-1');
        });

        it('does not report what the resource itself depends on', async () => {
            const edges = await repo.getBlastRadius({
                tenantId: TENANT,
                resourceType: 'ec2_instances',
                resourceId: 'i-1',
                depth: 3,
            });

            expect(edges.map(key)).not.toContain('i-1|in_vpc|vpc-1');
        });

        it('honors the depth limit', async () => {
            const edges = await repo.getBlastRadius({
                tenantId: TENANT,
                resourceType: 'ec2_instances',
                resourceId: 'i-1',
                depth: 1,
            });

            expect(edges.map(key).sort()).toEqual(
                ['arn:tg|routes_to_instance|i-1', 'vol-1|attached_to|i-1'].sort(),
            );
        });

        it('scopes to the requesting tenant', async () => {
            const edges = await repo.getBlastRadius({
                tenantId: OTHER_TENANT,
                resourceType: 'ec2_vpcs',
                resourceId: 'vpc-1',
                depth: 3,
            });

            expect(edges).toHaveLength(0);
        });
    });

    describe.skipIf(!HAS_DB)('summarise', () => {
        it('returns one row per account with resource and edge counts', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.summarise({ tenantId: TENANT });

            expect(result.accounts.length).toBeGreaterThan(0);
            for (const account of result.accounts) {
                expect(typeof account.accountId).toBe('string');
                expect(account.edgeCount).toBeGreaterThanOrEqual(0);
            }
            expect(result.byResourceType).toEqual([]);
            expect(result.byRelation).toEqual([]);
        });

        it('breaks down by type and relation when scoped to one account', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const all = await repo.summarise({ tenantId: TENANT });
            const accountId = all.accounts[0].accountId;

            const scoped = await repo.summarise({ tenantId: TENANT, accountId });

            expect(scoped.accounts).toHaveLength(1);
            expect(scoped.accounts[0].accountId).toBe(accountId);
            expect(scoped.byRelation.length).toBeGreaterThan(0);
            expect(scoped.byRelation.every((r) => r.count > 0)).toBe(true);
        });

        it('never counts another tenant', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const mine = await repo.summarise({ tenantId: TENANT });
            const theirs = await repo.summarise({ tenantId: OTHER_TENANT });

            const myIds = mine.accounts.map((a) => a.accountId);
            const theirEdges = theirs.accounts.reduce((n, a) => n + a.edgeCount, 0);
            const myEdges = mine.accounts.reduce((n, a) => n + a.edgeCount, 0);
            expect(myEdges).toBeGreaterThan(0);
            expect(myIds.length).toBeGreaterThan(0);
            expect(theirEdges).not.toBe(myEdges);
        });
    });

    describe.skipIf(!HAS_DB)('getSeed', () => {
        it('returns the whole account when it is under the cap, and says so', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const seed = await repo.getSeed({ tenantId: TENANT, accountId: CANVAS_ACCOUNT });

            expect(seed.mode).toBe('full-account');
            expect(seed.nodes).toHaveLength(5);
            expect(seed.totalVisibleNodes).toBe(5);
            expect(seed.truncated).toBe(false);
        });

        it('returns only structural types once the account exceeds the cap', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const seed = await repo.getSeed({ tenantId: TENANT, accountId: CANVAS_ACCOUNT, limit: 1 });

            expect(seed.mode).toBe('structural');
            expect(seed.nodes).toHaveLength(1);
            expect(STRUCTURAL_TYPES).toContain(seed.nodes[0].resourceType);
            expect(seed.truncated).toBe(true);
        });

        it('drops the edge whose far endpoint is a hidden node', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const seed = await repo.getSeed({ tenantId: TENANT, accountId: CANVAS_ACCOUNT });
            const present = new Set(seed.nodes.map((n) => `${n.resourceType}|${n.resourceId}`));

            expect(seed.edges).toHaveLength(5);
            expect(seed.edges.some((e) => e.relation === 'uses_iam_role')).toBe(false);
            for (const edge of seed.edges) {
                expect(present.has(`${edge.fromType}|${edge.fromId}`)).toBe(true);
                expect(present.has(`${edge.toType}|${edge.toId}`)).toBe(true);
            }
        });

        it('excludes hidden node types unless asked', async () => {
            const repo = new ResourceGraphPostgresRepository();

            const hidden = await repo.getSeed({ tenantId: TENANT, accountId: CANVAS_ACCOUNT });
            expect(hidden.nodes.some((n) => n.resourceType === 'iam_roles')).toBe(false);

            const shown = await repo.getSeed({
                tenantId: TENANT,
                accountId: CANVAS_ACCOUNT,
                filters: { includeHiddenTypes: true },
            });
            expect(shown.nodes.some((n) => n.resourceId === 'canvas-role-1')).toBe(true);
            expect(shown.edges.some((e) => e.relation === 'uses_iam_role')).toBe(true);
        });
    });

    describe.skipIf(!HAS_DB)('getSeed cross-account edge targets', () => {
        it('includes an edge to a resource owned by another account, flagged external', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const seed = await repo.getSeed({ tenantId: TENANT, accountId: CROSS_ACCOUNT });

            const external = seed.nodes.find((n) => n.resourceId === 'kms-shared-1');
            expect(external).toBeDefined();
            expect(external?.external).toBe(true);
            expect(external?.accountId).toBe(EXTERNAL_ACCOUNT);
            expect(seed.edges.some((e) => e.fromId === 'kms-shared-1' || e.toId === 'kms-shared-1')).toBe(true);
        });

        it('never resolves an edge target against another tenant\'s inventory', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const seed = await repo.getSeed({ tenantId: TENANT, accountId: CROSS_ACCOUNT });

            expect(seed.nodes.some((n) => n.resourceId === 'kms-tenant-leak-1')).toBe(false);
            expect(seed.edges.some((e) => e.fromId === 'kms-tenant-leak-1' || e.toId === 'kms-tenant-leak-1')).toBe(false);
        });

        it('leaves a same-account seed with no cross-account edges unchanged', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const seed = await repo.getSeed({ tenantId: TENANT, accountId: CANVAS_ACCOUNT });

            expect(seed.nodes).toHaveLength(5);
            expect(seed.edges).toHaveLength(5);
            expect(seed.nodes.every((n) => !n.external)).toBe(true);
        });
    });

    describe.skipIf(!HAS_DB)('expand', () => {
        it('returns both directions for the fixture instance', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.expand({
                tenantId: TENANT,
                resourceType: 'ec2_instances',
                resourceId: 'i-1',
            });

            expect(result.dependsOn.edges.some((e) => e.other.resourceId === 'vpc-1')).toBe(true);
            expect(result.dependents.edges.some((e) => e.other.resourceId === 'vol-1')).toBe(true);
        });

        it('reports the true total even when the cap truncates', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.expand({
                tenantId: TENANT,
                resourceType: 'ec2_vpcs',
                resourceId: 'vpc-1',
            });

            expect(result.dependents.total).toBeGreaterThanOrEqual(result.dependents.edges.length);
            if (result.dependents.truncated) {
                expect(result.dependents.total).toBeGreaterThan(result.dependents.edges.length);
            }
        });

        it('leaves getResourceDependencies unfiltered', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const deps = await repo.getResourceDependencies({
                tenantId: TENANT,
                resourceType: 'ec2_instances',
                resourceId: 'i-1',
            });

            expect(deps.dependsOn.edges.length).toBeGreaterThan(0);
        });
    });

    describe('findPath', () => {
        it('finds the chain from the instance to the load balancer', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.findPath({
                tenantId: TENANT,
                from: { resourceType: 'ec2_instances', resourceId: 'i-1' },
                to: { resourceType: 'elbv2_load_balancers', resourceId: 'arn:lb' },
            });

            expect(result.found).toBe(true);
            expect(result.hops.length).toBeGreaterThan(0);
            expect(result.hops[result.hops.length - 1].resourceId).toBe('arn:lb');
        });

        it('says plainly that there is no path rather than inventing one', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.findPath({
                tenantId: TENANT,
                from: { resourceType: 'ec2_instances', resourceId: 'i-1' },
                to: { resourceType: 's3_buckets', resourceId: 'no-such-bucket' },
            });

            expect(result.found).toBe(false);
            expect(result.hops).toEqual([]);
        });

        it('does not cross the tenant boundary', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.findPath({
                tenantId: OTHER_TENANT,
                from: { resourceType: 'ec2_instances', resourceId: 'i-1' },
                to: { resourceType: 'elbv2_load_balancers', resourceId: 'arn:lb' },
            });

            expect(result.found).toBe(false);
        });
    });

    describe.skipIf(!HAS_DB)('queryGraph', () => {
        it('returns nodes of one type plus the edges among them', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.queryGraph({
                tenantId: TENANT,
                predicate: { kind: 'by-type', resourceType: 'ec2_instances' },
            });

            expect(result.nodes.every((n) => n.resourceType === 'ec2_instances')).toBe(true);
            const present = new Set(result.nodes.map((n) => `${n.resourceType}|${n.resourceId}`));
            for (const e of result.edges) {
                expect(present.has(`${e.fromType}|${e.fromId}`)).toBe(true);
            }
        });

        it('returns everything sitting in one vpc, including the vpc itself', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.queryGraph({
                tenantId: TENANT,
                predicate: { kind: 'by-vpc', vpcId: 'canvas-vpc-1' },
            });

            const ids = result.nodes.map((n) => n.resourceId);
            expect(ids).toContain('canvas-vpc-1');
            expect(ids).toContain('canvas-i-1');
            expect(ids).toContain('canvas-subnet-1');
            expect(ids).toContain('canvas-lb-1');
            // vpc-1 exists in resource_edges but never in inventory_resources, so a resource
            // whose only vpc is acc-1's dangling vpc must not appear here.
            expect(ids).not.toContain('i-1');
        });

        it('reports the true total when the limit truncates', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.queryGraph({
                tenantId: TENANT,
                predicate: { kind: 'by-type', resourceType: 'ec2_instances' },
                limit: 1,
            });

            expect(result.nodes.length).toBeLessThanOrEqual(1);
            if (result.total > 1) expect(result.truncated).toBe(true);
        });

        it('returns each edge once when a resource id repeats across accounts', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.queryGraph({
                tenantId: TENANT,
                predicate: { kind: 'by-vpc', vpcId: 'canvas-vpc-1' },
            });

            const seen = result.edges.map((e) => `${e.fromType}|${e.fromId}|${e.relation}|${e.toType}|${e.toId}`);
            expect(new Set(seen).size).toBe(seen.length);
            expect(seen.filter((k) => k.startsWith('ec2_instances|canvas-i-1|in_vpc'))).toHaveLength(1);
        });

        it('still returns getSeed unchanged for a single-account node set', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const seed = await repo.getSeed({ tenantId: TENANT, accountId: CANVAS_ACCOUNT });

            expect(seed.nodes).toHaveLength(5);
            expect(seed.edges).toHaveLength(5);
        });

        it('rejects an unknown predicate rather than returning everything', async () => {
            const repo = new ResourceGraphPostgresRepository();
            await expect(
                repo.queryGraph({ tenantId: TENANT, predicate: { kind: 'nonsense' } as never }),
            ).rejects.toThrow(/unknown predicate/i);
        });

        it('does not silence an explicit by-type request for a hidden node type', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.queryGraph({
                tenantId: TENANT,
                predicate: { kind: 'by-type', resourceType: 'iam_roles' },
            });

            expect(result.nodes.map((n) => n.resourceId)).toContain('canvas-role-1');
        });

        it('still hides hidden node types for by-vpc', async () => {
            const repo = new ResourceGraphPostgresRepository();
            const result = await repo.queryGraph({
                tenantId: TENANT,
                predicate: { kind: 'by-vpc', vpcId: 'canvas-vpc-1' },
            });

            expect(result.nodes.map((n) => n.resourceId)).not.toContain('canvas-ssm-1');
        });
    });
});

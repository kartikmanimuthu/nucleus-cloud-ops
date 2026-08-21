/**
 * Gate 3 wiring — all five row-filtered list endpoints.
 *
 * prisma-filter.test.ts proves the filter is BUILT correctly and composes safely.
 * This proves each repository actually APPLIES it: a repository that accepted
 * `rowFilter` and silently ignored it would pass every test in that file while
 * leaking the entire tenant to a conditionally-granted role.
 *
 * Two things are asserted for each list method, on BOTH the page query and the
 * count query (a filtered page with an unfiltered total is its own information
 * leak — it tells the caller how many rows they cannot see):
 *
 *   1. the tenant predicate is still there, at the top level;
 *   2. the repository's own clauses — including the `OR` search clause, which is
 *      the one a naive spread-merge would destroy — are untouched.
 *
 * The tenant client is mocked (there is no database here) but `andWhere` is the
 * real implementation: only `getTenantClient` / `getPrismaClient` are replaced.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/db/pg-config')>();
    return { ...actual, getPrismaClient: vi.fn(), getTenantClient: vi.fn() };
});

import { applyTenantScope, getTenantClient } from '@/lib/db/pg-config';

import { AccountPostgresRepository } from './account/postgres';
import { AgentMemoryPostgresRepository } from './agent-memory/postgres';
import { AgentOpsRunPostgresRepository } from './agent-ops-run/postgres';
import { AuditLogPostgresRepository } from './audit-log/postgres';
import { CertificatePostgresRepository } from './certificate/postgres';
import { InventoryPostgresRepository } from './inventory/postgres';
import { KnowledgeBasePostgresRepository } from './knowledge-base/postgres';
import { RightSizingPostgresRepository } from './right-sizing/postgres';
import { SchedulePostgresRepository } from './schedule/postgres';
import { SkillPostgresRepository } from './skill/postgres';
import { SpotGuardPostgresRepository } from './spot-guard/postgres';

const TENANT = 'tenant-a';
/** What readFilterFor() produces for `read` granted on two accounts. */
const ROW_FILTER = { OR: [{ accountId: { in: ['acc-1', 'acc-2'] } }] };

const getTenantClientMock = getTenantClient as unknown as MockedFunction<any>;

/** A model stub whose findMany/count record the args they were handed. */
function modelStub(rows: unknown[] = []) {
    return {
        findMany: vi.fn().mockResolvedValue(rows),
        count: vi.fn().mockResolvedValue(rows.length),
    };
}

/** Both queries must carry the tenant AND the row filter — not one or the other. */
function expectIntersected(model: { findMany: any; count: any }, expectations: (where: any) => void) {
    const wheres = [model.findMany.mock.calls[0][0].where, model.count.mock.calls[0][0].where];

    // Tenant scoping comes from the CLIENT, not from each repository's `where`:
    // these repositories query through getTenantClient(tenantId), and the
    // extension injects the tenant predicate (see applyTenantScope in
    // pg-config.ts, whose spread puts tenantId last so no caller can displace
    // it). Asserting `where.tenantId` here would only pass for the repositories
    // that happen to also set it inline, and would wrongly fail the ones relying
    // on the extension — which are equally scoped.
    expect(getTenantClientMock).toHaveBeenCalledWith(TENANT);

    for (const where of wheres) {
        // The row filter must be AND-ed in, never spread-merged over the top.
        expect(where.AND).toEqual([ROW_FILTER]);

        // And it must still be AND-ed after the real extension has run, i.e. the
        // filter and the tenant predicate coexist rather than displacing one
        // another. This is the composition the whole workstream turns on.
        const reaching = applyTenantScope('Schedule', 'findMany', { where }, TENANT);
        expect(reaching.where.tenantId).toBe(TENANT);
        expect(reaching.where.AND).toEqual([ROW_FILTER]);

        expectations(where);
    }

    // The two queries must agree, or page and total describe different row sets.
    expect(wheres[0]).toEqual(wheres[1]);
}

/**
 * Same contract as expectIntersected, for repositories whose list method issues
 * a single findMany with no separate count query (skills, knowledge bases,
 * audit logs) — so there is nothing to cross-check for page/total agreement.
 */
function expectFindManyIntersected(
    model: { findMany: any },
    prismaModelName: string,
    expectations: (where: any) => void
) {
    expect(getTenantClientMock).toHaveBeenCalledWith(TENANT);

    const where = model.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([ROW_FILTER]);

    const reaching = applyTenantScope(prismaModelName, 'findMany', { where }, TENANT);
    expect(reaching.where.tenantId).toBe(TENANT);
    expect(reaching.where.AND).toEqual([ROW_FILTER]);

    expectations(where);
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('Gate 3 row filter reaches every list query', () => {
    it('schedules — filter intersected, search OR preserved', async () => {
        const schedule = modelStub();
        getTenantClientMock.mockReturnValue({ schedule });

        await new SchedulePostgresRepository().getSchedules({
            tenantId: TENANT,
            searchTerm: 'nightly',
            rowFilter: ROW_FILTER,
        });

        expectIntersected(schedule, (where) => {
            expect(where.OR).toEqual([
                { name: { contains: 'nightly', mode: 'insensitive' } },
                { description: { contains: 'nightly', mode: 'insensitive' } },
            ]);
        });
    });

    it('inventory resources — filter intersected, existing column filters preserved', async () => {
        const inventoryResource = modelStub();
        getTenantClientMock.mockReturnValue({ inventoryResource });

        await new InventoryPostgresRepository().listResources({
            tenantId: TENANT,
            region: 'us-east-1',
            rowFilter: ROW_FILTER,
        });

        expectIntersected(inventoryResource, (where) => {
            expect(where.region).toBe('us-east-1');
            expect(where.isCurrent).toBe(true);
        });
    });

    it('inventory resources — a search with a row filter avoids the raw-SQL path entirely', async () => {
        // $queryRawUnsafe is NOT intercepted by the tenant extension and cannot
        // carry a Prisma where fragment, so taking that path with a row filter
        // active would drop the filter silently. It must fall back to Prisma.
        const inventoryResource = modelStub();
        const $queryRawUnsafe = vi.fn();
        getTenantClientMock.mockReturnValue({ inventoryResource, $queryRawUnsafe });

        await new InventoryPostgresRepository().listResources({
            tenantId: TENANT,
            searchTerm: 'web',
            rowFilter: ROW_FILTER,
        });

        expect($queryRawUnsafe).not.toHaveBeenCalled();
        expectIntersected(inventoryResource, (where) => {
            expect(where.OR).toEqual([
                { name: { contains: 'web', mode: 'insensitive' } },
                { resourceId: { contains: 'web', mode: 'insensitive' } },
            ]);
        });
    });

    it('inventory resources — the fulltext path still runs when no row filter applies', async () => {
        // The fallback above is a cost paid only by conditionally-granted roles;
        // everyone else keeps ts_rank relevance ordering.
        const inventoryResource = modelStub();
        // The fulltext path issues two raw queries — a page and a count — and the
        // page result is mapped into UI rows, so it must be shaped like real rows
        // rather than reusing the count shape.
        const $queryRawUnsafe = vi.fn().mockImplementation(async (sql: string) =>
            /count\(/i.test(sql) ? [{ total: 0 }] : []
        );
        getTenantClientMock.mockReturnValue({ inventoryResource, $queryRawUnsafe });

        await new InventoryPostgresRepository().listResources({ tenantId: TENANT, searchTerm: 'web' });

        expect($queryRawUnsafe).toHaveBeenCalled();
        expect(inventoryResource.findMany).not.toHaveBeenCalled();
    });

    it('spot-guard services — filter intersected, search OR preserved', async () => {
        const spotGuardService = modelStub();
        getTenantClientMock.mockReturnValue({ spotGuardService });

        await new SpotGuardPostgresRepository().listServices({
            tenantId: TENANT,
            searchTerm: 'api',
            capacityState: 'spot',
            rowFilter: ROW_FILTER,
        });

        expectIntersected(spotGuardService, (where) => {
            expect(where.capacityState).toBe('spot');
            expect(where.OR).toEqual([
                { serviceName: { contains: 'api', mode: 'insensitive' } },
                { clusterName: { contains: 'api', mode: 'insensitive' } },
            ]);
        });
    });

    it('right-sizing recommendations — filter intersected, search OR preserved', async () => {
        const rightSizingRecommendation = modelStub();
        getTenantClientMock.mockReturnValue({ rightSizingRecommendation });

        await new RightSizingPostgresRepository().listRecommendations({
            tenantId: TENANT,
            searchTerm: 'i-0',
            status: 'open',
            rowFilter: ROW_FILTER,
        });

        expectIntersected(rightSizingRecommendation, (where) => {
            expect(where.status).toBe('open');
            expect(where.OR).toEqual([
                { resourceId: { contains: 'i-0', mode: 'insensitive' } },
                { name: { contains: 'i-0', mode: 'insensitive' } },
            ]);
        });
    });

    it('certificates — filter intersected, search OR preserved', async () => {
        const certificate = modelStub();
        getTenantClientMock.mockReturnValue({ certificate });

        await new CertificatePostgresRepository().listCertificates({
            tenantId: TENANT,
            searchTerm: 'example',
            status: 'active',
            rowFilter: ROW_FILTER,
        });

        expectIntersected(certificate, (where) => {
            expect(where.status).toBe('active');
            expect(where.OR).toEqual([
                { name: { contains: 'example', mode: 'insensitive' } },
                { domainName: { contains: 'example', mode: 'insensitive' } },
            ]);
        });
    });

    it('omitting the row filter leaves every query exactly as it was', async () => {
        // The shadow-mode path: getReadRowFilter() returns null until
        // DYNAMIC_ABAC_ENABLED flips, and that must be a true no-op.
        const schedule = modelStub();
        getTenantClientMock.mockReturnValue({ schedule });

        await new SchedulePostgresRepository().getSchedules({ tenantId: TENANT, rowFilter: null });

        const where = schedule.findMany.mock.calls[0][0].where;
        expect(where).toEqual({ tenantId: TENANT });
        expect(where.AND).toBeUndefined();
    });

    // ── The six endpoints wired in this pass ─────────────────────────────────

    it('accounts — filter intersected, search OR preserved', async () => {
        const account = modelStub();
        getTenantClientMock.mockReturnValue({ account });

        await new AccountPostgresRepository().getAccounts({
            tenantId: TENANT,
            searchTerm: 'prod',
            rowFilter: ROW_FILTER,
        });

        expectIntersected(account, (where) => {
            expect(where.OR).toEqual([
                { name: { contains: 'prod', mode: 'insensitive' } },
                { accountId: { contains: 'prod', mode: 'insensitive' } },
                { description: { contains: 'prod', mode: 'insensitive' } },
                { createdBy: { contains: 'prod', mode: 'insensitive' } },
            ]);
        });
    });

    it('accounts — omitting the row filter leaves the query exactly as it was', async () => {
        const account = modelStub();
        getTenantClientMock.mockReturnValue({ account });

        await new AccountPostgresRepository().getAccounts({ tenantId: TENANT, rowFilter: null });

        const where = account.findMany.mock.calls[0][0].where;
        expect(where).toEqual({ tenantId: TENANT });
        expect(where.AND).toBeUndefined();
    });

    it('agent-ops runs — filter intersected on the page query, the count, and the stats counts alike', async () => {
        const agentOpsRun = modelStub();
        getTenantClientMock.mockReturnValue({ agentOpsRun });

        await new AgentOpsRunPostgresRepository().listRuns({
            tenantId: TENANT,
            source: 'slack',
            rowFilter: ROW_FILTER,
        });

        expectIntersected(agentOpsRun, (where) => {
            expect(where.source).toBe('slack');
        });

        // computeStats() issues 4 more counts (total/inProgress/completed/failed)
        // against the same scoped `where` — a filtered page with unfiltered
        // stats would leak how many hidden rows exist in each status.
        for (const call of agentOpsRun.count.mock.calls) {
            expect(call[0].where.AND).toEqual([ROW_FILTER]);
        }
    });

    it('skills — filter intersected, isEnabled default preserved', async () => {
        const skill = modelStub();
        getTenantClientMock.mockReturnValue({ skill });

        await new SkillPostgresRepository().listByTenant(TENANT, { rowFilter: ROW_FILTER });

        expectFindManyIntersected(skill, 'Skill', (where) => {
            expect(where.isEnabled).toBe(true);
        });
    });

    it('knowledge bases — filter intersected', async () => {
        const knowledgeBase = modelStub();
        getTenantClientMock.mockReturnValue({ knowledgeBase });

        await new KnowledgeBasePostgresRepository().listKnowledgeBases(TENANT, ROW_FILTER);

        expectFindManyIntersected(knowledgeBase, 'KnowledgeBase', () => {});
    });

    it('audit logs — filter intersected, search OR preserved', async () => {
        const auditLog = modelStub();
        getTenantClientMock.mockReturnValue({ auditLog });

        await new AuditLogPostgresRepository().getAuditLogs(TENANT, {
            searchTerm: 'schedule',
            rowFilter: ROW_FILTER,
        });

        expectFindManyIntersected(auditLog, 'AuditLog', (where) => {
            expect(where.OR).toEqual([
                { action: { contains: 'schedule', mode: 'insensitive' } },
                { details: { contains: 'schedule', mode: 'insensitive' } },
                { user: { contains: 'schedule', mode: 'insensitive' } },
            ]);
        });
    });

    it('agent memories — filter intersected alongside the existing search AND', async () => {
        // listByTenant already puts its own search clause under `where.AND`
        // (see agent-memory/postgres.ts), so this is the one repository where
        // andWhere() must EXTEND an existing AND array rather than create one —
        // exactly the branch andWhere() carries for that reason.
        const agentMemory = modelStub();
        getTenantClientMock.mockReturnValue({ agentMemory });

        await new AgentMemoryPostgresRepository().listByTenant({
            tenantId: TENANT,
            search: 'ec2',
            rowFilter: ROW_FILTER,
        });

        expect(getTenantClientMock).toHaveBeenCalledWith(TENANT);
        const wheres = [agentMemory.findMany.mock.calls[0][0].where, agentMemory.count.mock.calls[0][0].where];

        for (const where of wheres) {
            expect(Array.isArray(where.AND)).toBe(true);
            // The row filter rides as the LAST conjunct, after the pre-existing
            // search clause — proving it was appended, not spread over the top.
            expect(where.AND[where.AND.length - 1]).toEqual(ROW_FILTER);

            const reaching = applyTenantScope('AgentMemory', 'findMany', { where }, TENANT);
            expect(reaching.where.tenantId).toBe(TENANT);
            expect(reaching.where.AND[reaching.where.AND.length - 1]).toEqual(ROW_FILTER);
        }

        expect(wheres[0]).toEqual(wheres[1]);
    });
});

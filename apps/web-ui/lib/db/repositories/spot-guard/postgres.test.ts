// web-ui/lib/db/repositories/spot-guard/postgres.test.ts
//
// Tests for classifyEligibility, the pure function behind the eligible-services list. It
// decides what the UI offers the user, so getting it wrong means either a disabled button
// with no explanation or an "Enable Spot" click that fails against AWS.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyEligibility, SpotGuardPostgresRepository } from './postgres';
import type { CapacityProviderStrategyItem, ServiceUpsert } from './interface';

// Hoisted so the vi.mock factory below can close over it (vi.mock is lifted above imports).
const {
    mockFindFirst, mockUpdate, mockCreate, mockDelete, mockFindMany, mockCount, mockGroupBy,
    mockEventFindMany, mockEventCount, mockEventCreate, mockQueryRaw, mockQueryRawUnsafe,
} = vi.hoisted(() => ({
    mockFindFirst: vi.fn(),
    mockUpdate: vi.fn(),
    mockCreate: vi.fn(),
    mockDelete: vi.fn(),
    mockFindMany: vi.fn(),
    mockCount: vi.fn(),
    mockGroupBy: vi.fn(),
    mockEventFindMany: vi.fn(),
    mockEventCount: vi.fn(),
    mockEventCreate: vi.fn(),
    mockQueryRaw: vi.fn(),
    mockQueryRawUnsafe: vi.fn(),
}));

// andWhere is real (imported via importOriginal) — it's pure, and stubbing it would hide the
// row-filter composition listServices depends on for Gate 3 tenant-scoping.
vi.mock('@/lib/db/pg-config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/db/pg-config')>()),
    getTenantClient: () => ({
        spotGuardService: {
            findFirst: mockFindFirst, update: mockUpdate, create: mockCreate, delete: mockDelete,
            findMany: mockFindMany, count: mockCount, groupBy: mockGroupBy,
        },
        spotGuardEvent: { findMany: mockEventFindMany, count: mockEventCount, create: mockEventCreate },
        $queryRaw: mockQueryRaw,
        $queryRawUnsafe: mockQueryRawUnsafe,
    }),
}));

const strategy = (...providers: string[]): CapacityProviderStrategyItem[] =>
    providers.map((capacityProvider) => ({ capacityProvider, weight: 1, base: 0 }));

describe('classifyEligibility', () => {
    it('is spot_capable when the strategy already contains a Spot provider', () => {
        // One click — nothing needs adding.
        expect(classifyEligibility(strategy('FARGATE', 'FARGATE_SPOT'), ['FARGATE', 'FARGATE_SPOT'])).toBe(
            'spot_capable',
        );
    });

    it('is spot_capable even when the Spot provider is currently zero-weighted', () => {
        // A service sitting in fallback still HAS Spot in its strategy; enabling is a
        // reweight, not an addition.
        expect(classifyEligibility([{ capacityProvider: 'FARGATE_SPOT', weight: 0 }], [])).toBe('spot_capable');
    });

    it('recognises a custom spot-named provider', () => {
        expect(classifyEligibility(strategy('my-spot-asg'), ['my-spot-asg'])).toBe('spot_capable');
    });

    it('is spot_addable when the cluster offers Spot but the strategy does not use it', () => {
        expect(classifyEligibility(strategy('FARGATE'), ['FARGATE', 'FARGATE_SPOT'])).toBe('spot_addable');
    });

    it('is needs_capacity_providers when neither strategy nor cluster offers Spot', () => {
        // The customer must register FARGATE_SPOT on the cluster first — something Nucleus
        // cannot do through UpdateService, so the UI must explain rather than offer.
        expect(classifyEligibility(strategy('FARGATE'), ['FARGATE'])).toBe('needs_capacity_providers');
    });

    it('is needs_capacity_providers for a bare launchType service with no strategy', () => {
        // Migrating off launchType is not an UpdateService call, so this is genuinely not
        // actionable from here.
        expect(classifyEligibility([], ['FARGATE', 'FARGATE_SPOT'])).toBe('needs_capacity_providers');
    });

    it('optimistically allows enable when the cluster providers are unknown', () => {
        // Discovery may not have captured the cluster row yet (or the join did not resolve).
        // Offering the action is right: the enable mutation re-verifies against LIVE AWS and
        // returns an actionable 409 listing the cluster's real providers. Hiding the button
        // on missing metadata would strand a genuinely eligible service.
        expect(classifyEligibility(strategy('FARGATE'), [])).toBe('spot_addable');
    });

    it('classifies the three real seeded fixtures as expected', () => {
        // Mirrors the rows the eligible query was verified against in a live database.
        expect(classifyEligibility(strategy('FARGATE_SPOT'), ['FARGATE', 'FARGATE_SPOT'])).toBe('spot_capable');
        expect(classifyEligibility(strategy('FARGATE'), ['FARGATE', 'FARGATE_SPOT'])).toBe('spot_addable');
        expect(classifyEligibility([], [])).toBe('needs_capacity_providers');
    });
});

describe('findServiceByTarget', () => {
    beforeEach(() => {
        mockFindFirst.mockReset();
        mockFindFirst.mockResolvedValue(null);
    });

    const TARGET = {
        accountId: '688849551607',
        region: 'ap-south-1',
        clusterName: 'stx-kyc-ekyc-ecs-fargate',
        serviceName: 'stx-kyc-ekyc-pf-api',
    };

    it('sends ONLY the four key columns to Prisma when the caller passes a tagged union member', async () => {
        // REGRESSION (shipped bug): enableSpot's `target` is a discriminated union, and its
        // `discovered` member carries `kind: 'discovered'`. This method used to do
        // `where: { ...target }`, which spread that tag into the query and blew up with
        // "Unknown argument `kind`. Did you mean `id`?" — a 500 on every attempt to enable
        // Spot for a service that was not already in the registry, i.e. the entire
        // opt-in-from-discovery path.
        //
        // Typechecking cannot catch it: excess-property checks only fire on fresh object
        // literals, and the call site passes a variable. So assert on what reaches Prisma.
        await new SpotGuardPostgresRepository().findServiceByTarget('tenant-1', {
            ...TARGET,
            kind: 'discovered',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        expect(mockFindFirst).toHaveBeenCalledTimes(1);
        const where = mockFindFirst.mock.calls[0][0].where;
        expect(where).toEqual(TARGET);
        expect(where).not.toHaveProperty('kind');
        // Guard the general case too: any future tag must not reach the query either.
        expect(Object.keys(where).sort()).toEqual(['accountId', 'clusterName', 'region', 'serviceName']);
    });

    it('passes the four columns through unchanged for a clean target', async () => {
        await new SpotGuardPostgresRepository().findServiceByTarget('tenant-1', TARGET);
        expect(mockFindFirst.mock.calls[0][0].where).toEqual(TARGET);
    });

    it('returns the transformed service when a match is found', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'sg-1', createdAt: new Date(), updatedAt: new Date(), desiredStrategy: [], observedStrategy: [],
        });
        const result = await new SpotGuardPostgresRepository().findServiceByTarget('tenant-1', TARGET);
        expect(result?.id).toBe('sg-1');
    });
});

describe('upsertService', () => {
    const BASE: ServiceUpsert = {
        accountId: '688849551607',
        region: 'ap-south-1',
        clusterName: 'stx-kyc-ekyc-ecs-fargate',
        serviceName: 'stx-kyc-ekyc-pf-api',
        desiredStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 100 }],
        capacityState: 'spot',
        managementState: 'managed',
    };

    // Enough for transformService to run without throwing — only createdAt/updatedAt call a
    // method (.toISOString()) on the raw record; everything else passes through as-is.
    const RECORD = { id: 'sg-1', createdAt: new Date(), updatedAt: new Date() };

    beforeEach(() => {
        mockFindFirst.mockReset();
        mockUpdate.mockReset();
        mockCreate.mockReset();
    });

    // REGRESSION (shipped bug): enableSpot and disableSpot both apply a strategy directly
    // against live AWS, so any restore the hourly job had queued is already moot and any
    // backoff no longer applies — a human just acted directly. Before resetRestoreState
    // existed, neither call site cleared restorePending/backoffUntil, so a service disabled
    // while a restore was pending stayed opted_out AND restorePending=true. The worker's own
    // candidate query already excludes non-managed rows, so nothing unsafe happened — but the
    // detail page went on claiming "Restore pending: yes" for a service that will never
    // actually be restored while it stays opted out.
    it('clears restorePending and backoffUntil when resetRestoreState is set, on an existing row', async () => {
        mockFindFirst.mockResolvedValue({ id: 'sg-1' });
        mockUpdate.mockResolvedValue(RECORD);

        await new SpotGuardPostgresRepository().upsertService('tenant-1', {
            ...BASE,
            managementState: 'opted_out',
            disabledBy: 'a@b.com',
            resetRestoreState: true,
        });

        expect(mockUpdate).toHaveBeenCalledTimes(1);
        const data = mockUpdate.mock.calls[0][0].data;
        expect(data.restorePending).toBe(false);
        expect(data.backoffUntil).toBeNull();
    });

    it('leaves restorePending and backoffUntil untouched when resetRestoreState is omitted', async () => {
        // The machine-driven observer path (handle-spot-event.ts) upserts on every task
        // transition and must NOT reset these — that would erase a restore the worker itself
        // just queued moments earlier.
        mockFindFirst.mockResolvedValue({ id: 'sg-1' });
        mockUpdate.mockResolvedValue(RECORD);

        await new SpotGuardPostgresRepository().upsertService('tenant-1', BASE);

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('restorePending');
        expect(data).not.toHaveProperty('backoffUntil');
    });

    it('clears restorePending and backoffUntil on a first-time insert too', async () => {
        mockFindFirst.mockResolvedValue(null);
        mockCreate.mockResolvedValue(RECORD);

        await new SpotGuardPostgresRepository().upsertService('tenant-1', {
            ...BASE,
            enabledBy: 'a@b.com',
            resetRestoreState: true,
        });

        expect(mockCreate).toHaveBeenCalledTimes(1);
        const data = mockCreate.mock.calls[0][0].data;
        expect(data.restorePending).toBe(false);
        expect(data.backoffUntil).toBeNull();
    });

    it('passes tenantId explicitly on create even though the tenant client injects it too', async () => {
        mockFindFirst.mockResolvedValue(null);
        mockCreate.mockResolvedValue(RECORD);

        await new SpotGuardPostgresRepository().upsertService('tenant-1', BASE);

        expect(mockCreate.mock.calls[0][0].data.tenantId).toBe('tenant-1');
    });

    it('sets desiredCount, runningCount, and updatedBy only when explicitly supplied, on update', async () => {
        mockFindFirst.mockResolvedValue({ id: 'sg-1' });
        mockUpdate.mockResolvedValue(RECORD);

        await new SpotGuardPostgresRepository().upsertService('tenant-1', {
            ...BASE, desiredCount: 3, runningCount: 2, actor: 'a@b.com',
        });

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data.desiredCount).toBe(3);
        expect(data.runningCount).toBe(2);
        expect(data.updatedBy).toBe('a@b.com');
    });

    it('omits desiredCount, runningCount, and updatedBy when not supplied, on update', async () => {
        mockFindFirst.mockResolvedValue({ id: 'sg-1' });
        mockUpdate.mockResolvedValue(RECORD);

        await new SpotGuardPostgresRepository().upsertService('tenant-1', BASE);

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('desiredCount');
        expect(data).not.toHaveProperty('runningCount');
        expect(data).not.toHaveProperty('updatedBy');
    });

    it('records createdBy only on the initial insert, never rewritten by a later update', async () => {
        mockFindFirst.mockResolvedValue(null);
        mockCreate.mockResolvedValue(RECORD);

        await new SpotGuardPostgresRepository().upsertService('tenant-1', { ...BASE, actor: 'creator@b.com' });

        expect(mockCreate.mock.calls[0][0].data.createdBy).toBe('creator@b.com');
    });

    it('omits createdBy on insert when no actor is supplied', async () => {
        mockFindFirst.mockResolvedValue(null);
        mockCreate.mockResolvedValue(RECORD);

        await new SpotGuardPostgresRepository().upsertService('tenant-1', BASE);

        expect(mockCreate.mock.calls[0][0].data).not.toHaveProperty('createdBy');
    });
});

describe('getFacets', () => {
    it('returns distinct regions and cluster names', async () => {
        mockGroupBy
            .mockResolvedValueOnce([{ region: 'ap-south-1' }, { region: 'us-east-1' }])
            .mockResolvedValueOnce([{ clusterName: 'cluster-a' }]);

        const result = await new SpotGuardPostgresRepository().getFacets('tenant-1');

        expect(result).toEqual({ regions: ['ap-south-1', 'us-east-1'], clusters: ['cluster-a'] });
    });
});

describe('listServices', () => {
    const RECORD = {
        id: 'sg-1', createdAt: new Date(), updatedAt: new Date(),
        desiredStrategy: [], observedStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }],
        accountId: 'acct-1', region: 'ap-south-1', serviceName: 'svc-1',
    };

    beforeEach(() => {
        mockFindMany.mockReset().mockResolvedValue([RECORD]);
        mockCount.mockReset().mockResolvedValue(1);
        mockQueryRawUnsafe.mockReset().mockResolvedValue([]);
    });

    it('builds an equality where clause from every provided filter', async () => {
        await new SpotGuardPostgresRepository().listServices({
            tenantId: 'tenant-1', accountId: 'acct-1', region: 'ap-south-1',
            clusterName: 'cluster-a', capacityState: 'spot', managementState: 'managed',
        });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where).toMatchObject({
            accountId: 'acct-1', region: 'ap-south-1', clusterName: 'cluster-a',
            capacityState: 'spot', managementState: 'managed',
        });
    });

    it('searches serviceName and clusterName case-insensitively', async () => {
        await new SpotGuardPostgresRepository().listServices({ tenantId: 'tenant-1', searchTerm: 'api' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.OR).toEqual([
            { serviceName: { contains: 'api', mode: 'insensitive' } },
            { clusterName: { contains: 'api', mode: 'insensitive' } },
        ]);
    });

    it('intersects a Gate-3 row filter under AND without discarding the search OR clause', async () => {
        await new SpotGuardPostgresRepository().listServices({
            tenantId: 'tenant-1', searchTerm: 'api', rowFilter: { accountId: { in: ['acct-1'] } },
        });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.OR).toBeDefined();
        expect(where.AND).toEqual([{ accountId: { in: ['acct-1'] } }]);
    });

    it('clamps page to a minimum of 1 and limit to the 1-200 range', async () => {
        await new SpotGuardPostgresRepository().listServices({ tenantId: 'tenant-1', page: -5, limit: 5000 });
        expect(mockFindMany.mock.calls[0][0].skip).toBe(0);
        expect(mockFindMany.mock.calls[0][0].take).toBe(200);

        await new SpotGuardPostgresRepository().listServices({ tenantId: 'tenant-1', page: 3, limit: 0 });
        expect(mockFindMany.mock.calls[1][0].skip).toBe(2); // page 3 at the limit-clamped-to-1 floor
        expect(mockFindMany.mock.calls[1][0].take).toBe(1);
    });

    it('backfills observedStrategy from inventory for rows discovery has not populated, scoped by tenant', async () => {
        mockFindMany.mockResolvedValue([{ ...RECORD, observedStrategy: [] }]);
        mockQueryRawUnsafe.mockResolvedValue([
            { accountId: 'acct-1', region: 'ap-south-1', name: 'svc-1', strategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }] },
        ]);

        const { services } = await new SpotGuardPostgresRepository().listServices({ tenantId: 'tenant-1' });

        expect(mockQueryRawUnsafe.mock.calls[0]).toContain('tenant-1');
        expect(services[0].observedStrategy).toEqual([{ capacityProvider: 'FARGATE_SPOT', weight: 1 }]);
        expect((services[0] as any).strategyFromInventory).toBe(true);
    });

    it('skips the backfill query entirely when every row already has a strategy', async () => {
        mockFindMany.mockResolvedValue([RECORD]);
        const { services } = await new SpotGuardPostgresRepository().listServices({ tenantId: 'tenant-1' });

        expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
        expect(services[0].observedStrategy).toEqual(RECORD.observedStrategy);
    });

    it('leaves a gapped row unchanged when inventory has no matching strategy for it', async () => {
        // Mixed page: one row already has a strategy (short-circuits per-row inside the
        // map — must NOT be re-fetched or overwritten), one has a gap the inventory join
        // does not resolve (no matching accountId|region|name key).
        mockFindMany.mockResolvedValue([RECORD, { ...RECORD, id: 'sg-2', observedStrategy: [] }]);
        mockQueryRawUnsafe.mockResolvedValue([]); // no inventory row matches the gapped service

        const { services } = await new SpotGuardPostgresRepository().listServices({ tenantId: 'tenant-1' });

        expect(services[0].observedStrategy).toEqual(RECORD.observedStrategy); // untouched, had a strategy
        expect(services[1].observedStrategy).toEqual([]); // still empty, no match found
        expect((services[1] as any).strategyFromInventory).toBeUndefined();
    });
});

describe('getService', () => {
    it('returns the transformed service when found', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'sg-1', createdAt: new Date(), updatedAt: new Date(), desiredStrategy: [], observedStrategy: [],
        });
        const result = await new SpotGuardPostgresRepository().getService('sg-1', 'tenant-1');
        expect(result?.id).toBe('sg-1');
    });

    it('returns null when not found', async () => {
        mockFindFirst.mockResolvedValue(null);
        const result = await new SpotGuardPostgresRepository().getService('missing', 'tenant-1');
        expect(result).toBeNull();
    });

    it('converts a populated optional timestamp and passes through an explicit null one', async () => {
        mockFindFirst.mockResolvedValue({
            id: 'sg-1', createdAt: new Date(), updatedAt: new Date(), desiredStrategy: [], observedStrategy: [],
            lastFallbackAt: new Date('2026-01-02T00:00:00Z'), enabledAt: null,
        });
        const result = await new SpotGuardPostgresRepository().getService('sg-1', 'tenant-1');
        expect(result?.lastFallbackAt).toBe('2026-01-02T00:00:00.000Z');
        expect(result?.enabledAt).toBeNull();
    });
});

describe('setManagementState', () => {
    beforeEach(() => {
        mockFindFirst.mockReset();
        mockUpdate.mockReset();
    });
    const RECORD = { id: 'sg-1', createdAt: new Date(), updatedAt: new Date(), desiredStrategy: [], observedStrategy: [] };

    it('throws NOT_FOUND for a cross-tenant id instead of leaking existence via a bare update', async () => {
        mockFindFirst.mockResolvedValue(null);
        await expect(
            new SpotGuardPostgresRepository().setManagementState('sg-x', 'tenant-1', 'managed', 'a@b.com')
        ).rejects.toThrow('NOT_FOUND');
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('sets enabledBy/enabledAt when moving to managed', async () => {
        mockFindFirst.mockResolvedValue({ id: 'sg-1' });
        mockUpdate.mockResolvedValue(RECORD);
        await new SpotGuardPostgresRepository().setManagementState('sg-1', 'tenant-1', 'managed', 'a@b.com');

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data.enabledBy).toBe('a@b.com');
        expect(data.enabledAt).toBeInstanceOf(Date);
        expect(data).not.toHaveProperty('restorePending');
    });

    it('sets disabledBy/disabledAt and clears restore state when moving to opted_out', async () => {
        mockFindFirst.mockResolvedValue({ id: 'sg-1' });
        mockUpdate.mockResolvedValue(RECORD);
        await new SpotGuardPostgresRepository().setManagementState('sg-1', 'tenant-1', 'opted_out', 'a@b.com');

        const data = mockUpdate.mock.calls[0][0].data;
        expect(data.disabledBy).toBe('a@b.com');
        expect(data.restorePending).toBe(false);
        expect(data.backoffUntil).toBeNull();
    });
});

describe('deleteService', () => {
    beforeEach(() => {
        mockFindFirst.mockReset();
        mockDelete.mockReset();
    });

    it('throws NOT_FOUND for a cross-tenant id instead of a bare delete', async () => {
        mockFindFirst.mockResolvedValue(null);
        await expect(new SpotGuardPostgresRepository().deleteService('sg-x', 'tenant-1')).rejects.toThrow('NOT_FOUND');
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('deletes the row when it belongs to the tenant', async () => {
        mockFindFirst.mockResolvedValue({ id: 'sg-1' });
        mockDelete.mockResolvedValue({});
        await new SpotGuardPostgresRepository().deleteService('sg-1', 'tenant-1');
        expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'sg-1' } });
    });
});

describe('listEvents', () => {
    const EVENT_RECORD = { id: 'ev-1', occurredAt: new Date(), metadata: null };

    beforeEach(() => {
        mockEventFindMany.mockReset().mockResolvedValue([EVENT_RECORD]);
        mockEventCount.mockReset().mockResolvedValue(1);
    });

    it('filters by a single eventType', async () => {
        await new SpotGuardPostgresRepository().listEvents({ tenantId: 'tenant-1', eventType: 'interruption' });
        expect(mockEventFindMany.mock.calls[0][0].where.eventType).toBe('interruption');
    });

    it('prefers eventTypes (multi-select) over a single eventType when both are given', async () => {
        await new SpotGuardPostgresRepository().listEvents({
            tenantId: 'tenant-1', eventType: 'interruption', eventTypes: ['fallback', 'restore'],
        });
        expect(mockEventFindMany.mock.calls[0][0].where.eventType).toEqual({ in: ['fallback', 'restore'] });
    });

    it('filters by since as a gte timestamp', async () => {
        await new SpotGuardPostgresRepository().listEvents({ tenantId: 'tenant-1', since: '2026-01-01T00:00:00Z' });
        expect(mockEventFindMany.mock.calls[0][0].where.occurredAt).toEqual({ gte: new Date('2026-01-01T00:00:00Z') });
    });

    it('returns transformed events and the total count', async () => {
        const result = await new SpotGuardPostgresRepository().listEvents({ tenantId: 'tenant-1' });
        expect(result).toEqual({ events: [expect.objectContaining({ id: 'ev-1' })], total: 1 });
    });

    it('builds an equality where clause from spotServiceId, accountId, serviceName, and severity', async () => {
        await new SpotGuardPostgresRepository().listEvents({
            tenantId: 'tenant-1', spotServiceId: 'sg-1', accountId: 'acct-1', serviceName: 'svc-1', severity: 'critical',
        });

        expect(mockEventFindMany.mock.calls[0][0].where).toMatchObject({
            spotServiceId: 'sg-1', accountId: 'acct-1', serviceName: 'svc-1', severity: 'critical',
        });
    });

    it('carries the before/after strategy snapshot through transformEvent when present', async () => {
        mockEventFindMany.mockResolvedValue([{
            ...EVENT_RECORD,
            strategyBefore: [{ capacityProvider: 'FARGATE', weight: 1 }],
            strategyAfter: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }],
        }]);

        const { events } = await new SpotGuardPostgresRepository().listEvents({ tenantId: 'tenant-1' });

        expect(events[0].strategyBefore).toEqual([{ capacityProvider: 'FARGATE', weight: 1 }]);
        expect(events[0].strategyAfter).toEqual([{ capacityProvider: 'FARGATE_SPOT', weight: 1 }]);
    });
});

describe('recordEvent', () => {
    beforeEach(() => {
        mockEventCreate.mockReset();
    });

    it('defaults severity, actor, and metadata, and binds tenantId explicitly', async () => {
        mockEventCreate.mockResolvedValue({ id: 'ev-1', occurredAt: new Date(), metadata: {} });

        await new SpotGuardPostgresRepository().recordEvent('tenant-1', {
            accountId: 'acct-1', region: 'ap-south-1', clusterName: 'c', serviceName: 's', eventType: 'interruption',
        });

        const data = mockEventCreate.mock.calls[0][0].data;
        expect(data.tenantId).toBe('tenant-1');
        expect(data.severity).toBe('info');
        expect(data.actor).toBe('system');
        expect(data.metadata).toEqual({});
        expect(data.expiresAt).toBeInstanceOf(Date);
    });

    it('passes through explicit severity, taskArn, and capacity transition fields', async () => {
        mockEventCreate.mockResolvedValue({ id: 'ev-1', occurredAt: new Date(), metadata: {} });

        await new SpotGuardPostgresRepository().recordEvent('tenant-1', {
            accountId: 'acct-1', region: 'ap-south-1', clusterName: 'c', serviceName: 's', eventType: 'fallback',
            severity: 'critical', taskArn: 'arn:aws:ecs:task/1', fromCapacity: 'spot', toCapacity: 'on_demand',
            actor: 'a@b.com',
        });

        const data = mockEventCreate.mock.calls[0][0].data;
        expect(data.severity).toBe('critical');
        expect(data.taskArn).toBe('arn:aws:ecs:task/1');
        expect(data.actor).toBe('a@b.com');
    });
});

describe('getHoursReport', () => {
    beforeEach(() => {
        mockQueryRaw.mockReset();
    });

    it('binds tenantId as a parameter on both the hours and data-quality raw queries', async () => {
        mockQueryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ orphaned: 0, staleOpen: 0 }]);

        const range = { from: new Date('2026-01-01'), to: new Date('2026-01-08') };
        await new SpotGuardPostgresRepository().getHoursReport('tenant-1', range);

        expect(mockQueryRaw).toHaveBeenCalledTimes(2);
        expect(mockQueryRaw.mock.calls[0]).toContain('tenant-1');
        expect(mockQueryRaw.mock.calls[1]).toContain('tenant-1');
    });

    it('folds spot and on-demand seconds per service into hours and a spot share', async () => {
        mockQueryRaw
            .mockResolvedValueOnce([
                {
                    accountId: 'acct-1', accountName: 'Acme', region: 'ap-south-1', clusterName: 'c', serviceName: 's',
                    capacityType: 'spot', seconds: 3600, sessions: 1, inFlightSessions: 0, interruptions: 0,
                },
                {
                    accountId: 'acct-1', accountName: 'Acme', region: 'ap-south-1', clusterName: 'c', serviceName: 's',
                    capacityType: 'on_demand', seconds: 1800, sessions: 1, inFlightSessions: 1, interruptions: 1,
                },
            ])
            .mockResolvedValueOnce([{ orphaned: 2, staleOpen: 1 }]);

        const range = { from: new Date('2026-01-01'), to: new Date('2026-01-08') };
        const report = await new SpotGuardPostgresRepository().getHoursReport('tenant-1', range);

        expect(report.rows).toHaveLength(1);
        expect(report.rows[0].spotHours).toBe(1);
        expect(report.rows[0].onDemandHours).toBe(0.5);
        expect(report.totals.spotShare).toBeCloseTo(2 / 3, 4);
        expect(report.totals.interruptions).toBe(1);
        expect(report.totals.inFlightSessions).toBe(1);
        expect(report.dataQuality).toEqual({ orphaned: 2, staleOpen: 1 });
    });

    it('reports zero share when there is no time in range', async () => {
        mockQueryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        const range = { from: new Date('2026-01-01'), to: new Date('2026-01-08') };
        const report = await new SpotGuardPostgresRepository().getHoursReport('tenant-1', range);

        expect(report.totals.spotShare).toBe(0);
        expect(report.dataQuality).toEqual({ orphaned: 0, staleOpen: 0 });
    });

    it('reports a zero share for a row whose seconds are missing, and null-safes missing fields', async () => {
        mockQueryRaw
            .mockResolvedValueOnce([{
                accountId: 'acct-1', accountName: null, region: 'ap-south-1', clusterName: 'c', serviceName: 's',
                capacityType: 'spot', seconds: undefined, sessions: null, inFlightSessions: null, interruptions: null,
            }])
            .mockResolvedValueOnce([]);

        const range = { from: new Date('2026-01-01'), to: new Date('2026-01-08') };
        const report = await new SpotGuardPostgresRepository().getHoursReport('tenant-1', range);

        expect(report.rows[0].accountName).toBeUndefined();
        expect(report.rows[0].spotShare).toBe(0);
        expect(report.rows[0].sessions).toBe(0);
        expect(report.dataQuality).toEqual({ orphaned: 0, staleOpen: 0 });
    });
});

describe('getSummary', () => {
    it('aggregates counts and folds in the 7-day hours report', async () => {
        mockCount
            .mockResolvedValueOnce(10) // managed
            .mockResolvedValueOnce(7) // onSpot
            .mockResolvedValueOnce(3); // inFallback (unmanaged uses a separate mock below)
        // Order of Promise.all: managed, onSpot, inFallback, unmanaged (service counts),
        // then interruptions, placementFailures (event counts) — split across the two mocks.
        mockCount.mockResolvedValueOnce(2); // unmanaged
        mockEventCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
        mockFindFirst.mockResolvedValue({ lastEventAt: new Date('2026-01-05T00:00:00Z') });
        mockQueryRaw.mockResolvedValue([]); // getHoursReport's two raw queries, both empty

        const summary = await new SpotGuardPostgresRepository().getSummary('tenant-1');

        expect(summary.managedServices).toBe(10);
        expect(summary.servicesOnSpot).toBe(7);
        expect(summary.servicesInFallback).toBe(3);
        expect(summary.servicesUnmanaged).toBe(2);
        expect(summary.interruptions24h).toBe(1);
        expect(summary.placementFailures24h).toBe(0);
        expect(summary.lastEventAt).toBe('2026-01-05T00:00:00.000Z');
    });

    it('reports a null lastEventAt when no service has ever emitted one', async () => {
        mockCount.mockResolvedValue(0);
        mockEventCount.mockResolvedValue(0);
        mockFindFirst.mockResolvedValue(null);
        mockQueryRaw.mockResolvedValue([]);

        const summary = await new SpotGuardPostgresRepository().getSummary('tenant-1');
        expect(summary.lastEventAt).toBeNull();
    });
});

// NOTE: postgres.ts:659's `clusterArn.split('/').pop() ?? null` fallback is not exercised
// anywhere below. String.prototype.split always returns a non-empty array, and .pop() on a
// non-empty array never returns undefined — the only way to reach that fallback would be an
// already-impossible empty split result. Left untested as provably unreachable, same
// convention as the documented dead branches in libs/rbac/rule-compiler.ts.
describe('listEligibleServices', () => {
    beforeEach(() => {
        mockQueryRaw.mockReset();
    });

    const ROW = {
        accountId: 'acct-1', region: 'ap-south-1', name: 'svc-1', resourceId: 'res-1',
        metadata: {
            capacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1 }],
            ecsClusterArn: 'arn:aws:ecs:cluster/c1',
        },
        clusterProviders: ['FARGATE', 'FARGATE_SPOT'], spotServiceId: null, managementState: null,
        registryStrategy: null,
    };

    it('scopes both the rows and the count query to the caller tenant via a bound parameter', async () => {
        mockQueryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0n }]);

        await new SpotGuardPostgresRepository().listEligibleServices({ tenantId: 'tenant-1' });

        expect(mockQueryRaw).toHaveBeenCalledTimes(2);
        expect(mockQueryRaw.mock.calls[0]).toContain('tenant-1');
        expect(mockQueryRaw.mock.calls[1]).toContain('tenant-1');
    });

    it('classifies eligibility and derives clusterName from the cluster ARN', async () => {
        mockQueryRaw.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1n }]);

        const { services, total } = await new SpotGuardPostgresRepository().listEligibleServices({ tenantId: 'tenant-1' });

        expect(total).toBe(1);
        expect(services[0].clusterName).toBe('c1');
        expect(services[0].eligibility).toBe('spot_addable');
        expect(services[0].registryStrategy).toBeNull();
    });

    it('surfaces the live registryStrategy only when the row is already tracked in the registry', async () => {
        mockQueryRaw.mockResolvedValueOnce([
            { ...ROW, spotServiceId: 'sg-1', registryStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }] },
        ]).mockResolvedValueOnce([{ total: 1n }]);

        const { services } = await new SpotGuardPostgresRepository().listEligibleServices({ tenantId: 'tenant-1' });
        expect(services[0].registryStrategy).toEqual([{ capacityProvider: 'FARGATE_SPOT', weight: 1 }]);
    });

    it('wraps a trimmed search term in ILIKE wildcards and binds it as a raw-query parameter', async () => {
        mockQueryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0n }]);

        await new SpotGuardPostgresRepository().listEligibleServices({ tenantId: 'tenant-1', searchTerm: '  api  ' });

        expect(mockQueryRaw.mock.calls[0]).toContain('%api%');
    });

    it('null-safes a row with sparse metadata and a non-array clusterProviders join result', async () => {
        mockQueryRaw.mockResolvedValueOnce([{
            accountId: 'acct-1', region: 'ap-south-1', name: 'svc-1', resourceId: 'res-1',
            metadata: {}, clusterProviders: null, spotServiceId: null, managementState: null, registryStrategy: null,
        }]).mockResolvedValueOnce([{ total: 1n }]);

        const { services } = await new SpotGuardPostgresRepository().listEligibleServices({ tenantId: 'tenant-1' });

        expect(services[0].clusterArn).toBeNull();
        expect(services[0].clusterName).toBeNull();
        expect(services[0].serviceArn).toBe('res-1'); // falls back to resourceId
        expect(services[0].launchType).toBeNull();
        expect(services[0].desiredCount).toBeNull();
        expect(services[0].clusterCapacityProviders).toEqual([]);
    });

    it('reports a live desiredCount and serviceArn when discovery metadata has them', async () => {
        mockQueryRaw.mockResolvedValueOnce([{
            accountId: 'acct-1', region: 'ap-south-1', name: 'svc-1', resourceId: 'res-1',
            metadata: { desiredCount: 4, serviceArn: 'arn:aws:ecs:service/1', launchType: 'FARGATE' },
            clusterProviders: [], spotServiceId: null, managementState: null, registryStrategy: null,
        }]).mockResolvedValueOnce([{ total: 1n }]);

        const { services } = await new SpotGuardPostgresRepository().listEligibleServices({ tenantId: 'tenant-1' });

        expect(services[0].desiredCount).toBe(4);
        expect(services[0].serviceArn).toBe('arn:aws:ecs:service/1');
        expect(services[0].launchType).toBe('FARGATE');
    });

    it('narrows the returned page by eligibility client-side without narrowing the total count', async () => {
        mockQueryRaw
            .mockResolvedValueOnce([ROW, { ...ROW, name: 'svc-2', metadata: { capacityProviderStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }] } }])
            .mockResolvedValueOnce([{ total: 2n }]);

        const { services, total } = await new SpotGuardPostgresRepository().listEligibleServices({
            tenantId: 'tenant-1', eligibility: 'spot_capable',
        });

        expect(services).toHaveLength(1);
        expect(services[0].serviceName).toBe('svc-2');
        expect(total).toBe(2); // total reflects the unfiltered count, per the pagination-bug regression note
    });
});

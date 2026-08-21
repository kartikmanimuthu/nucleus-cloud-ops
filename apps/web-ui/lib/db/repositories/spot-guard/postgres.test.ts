// web-ui/lib/db/repositories/spot-guard/postgres.test.ts
//
// Tests for classifyEligibility, the pure function behind the eligible-services list. It
// decides what the UI offers the user, so getting it wrong means either a disabled button
// with no explanation or an "Enable Spot" click that fails against AWS.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyEligibility, SpotGuardPostgresRepository } from './postgres';
import type { CapacityProviderStrategyItem, ServiceUpsert } from './interface';

// Hoisted so the vi.mock factory below can close over it (vi.mock is lifted above imports).
const { mockFindFirst, mockUpdate, mockCreate } = vi.hoisted(() => ({
    mockFindFirst: vi.fn(),
    mockUpdate: vi.fn(),
    mockCreate: vi.fn(),
}));

vi.mock('@/lib/db/pg-config', () => ({
    getTenantClient: () => ({
        spotGuardService: { findFirst: mockFindFirst, update: mockUpdate, create: mockCreate },
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
});

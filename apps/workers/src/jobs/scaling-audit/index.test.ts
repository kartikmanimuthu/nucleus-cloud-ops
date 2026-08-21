// workers/src/jobs/scaling-audit/index.test.ts
//
// Orchestration-level regression coverage for handleScan(): every AWS-calling
// service module is mocked (call-count/args assertions only — no real AWS or
// DB I/O). Each vi.mock() factory below is fully self-contained (no outer
// variable references — those get hoisted above the file's other top-level
// statements and would hit a TDZ ReferenceError, see
// https://vitest.dev/api/vi.html#vi-mock); behavior is configured afterward
// by importing the same named export back and calling vi.mocked(fn) on it.
//
// Two things are under test here, both regressions this suite exists to catch:
//   1. SCOPES was widened to 6 (asg/ecs/rds/msk/elasticache/docdb) but the
//      dispatch that actually POLLS each scope's fetcher(s) must be widened
//      to match — a scope present in SCOPES with no matching fetcher call
//      would silently collect nothing forever.
//   2. The new Network Pulse (DX/VPN) collection step runs unconditionally
//      alongside scope polling, and a failure in it must never abort the
//      rest of the scan for that account/region.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./services/db-writer.js', () => ({
    getScalingAuditEligibleAccounts: vi.fn(),
    createRun: vi.fn(),
    finishRun: vi.fn(),
    hasCompletedRun: vi.fn(),
    hasActiveRun: vi.fn(),
    getWatermark: vi.fn(),
    createCoverageRow: vi.fn(),
    updateCoverageRow: vi.fn(),
    upsertWatermark: vi.fn(),
    getInventoryResourceIds: vi.fn(),
    insertEvents: vi.fn(),
    upsertNetworkLinkSamples: vi.fn(),
}));
vi.mock('../discovery/services/sts-service.js', () => ({ assumeRole: vi.fn() }));
vi.mock('../discovery/services/audit-service.js', () => ({ writeAuditLog: vi.fn() }));
vi.mock('./services/policy-snapshot.js', () => ({
    fetchAsgPolicySnapshots: vi.fn(),
    fetchEcsPolicySnapshots: vi.fn(),
    upsertPolicySnapshots: vi.fn(),
}));
vi.mock('../../lib/cloudwatch-client.js', () => ({ fetchScalingEnrichment: vi.fn() }));

// ── The six scopes' aws_api + cloudtrail fetchers ────────────────────────────
vi.mock('./services/asg-client.js', () => ({ fetchAsgActivities: vi.fn() }));
vi.mock('./services/app-autoscaling-client.js', () => ({ fetchEcsScalingActivities: vi.fn() }));
vi.mock('./services/cloudtrail-client.js', () => ({ fetchCloudTrailCapacityChanges: vi.fn() }));
vi.mock('./services/rds-events-client.js', () => ({ fetchRdsStorageAutoscalingEvents: vi.fn() }));
vi.mock('./services/rds-cloudtrail-client.js', () => ({ fetchRdsCloudTrailCapacityChanges: vi.fn() }));
vi.mock('./services/docdb-events-client.js', () => ({ fetchDocDbEvents: vi.fn() }));
vi.mock('./services/docdb-cloudtrail-client.js', () => ({ fetchDocDbCloudTrailCapacityChanges: vi.fn() }));
vi.mock('./services/msk-operations-client.js', () => ({ fetchMskOperations: vi.fn() }));
vi.mock('./services/msk-cloudtrail-client.js', () => ({ fetchMskCloudTrailCapacityChanges: vi.fn() }));
vi.mock('./services/elasticache-cloudtrail-client.js', () => ({ fetchElastiCacheCloudTrailCapacityChanges: vi.fn() }));

// ── Network Pulse (DX/VPN) — Part 5b ─────────────────────────────────────────
vi.mock('./services/network-client.js', () => ({ fetchDirectConnectConnections: vi.fn(), fetchVpnTunnels: vi.fn() }));
vi.mock('./services/network-cloudwatch-client.js', () => ({ fetchNetworkUtilization: vi.fn() }));

import { handleScan } from './index.js';
import {
    getScalingAuditEligibleAccounts,
    createRun,
    finishRun,
    hasCompletedRun,
    hasActiveRun,
    getWatermark,
    createCoverageRow,
    updateCoverageRow,
    upsertWatermark,
    getInventoryResourceIds,
    insertEvents,
    upsertNetworkLinkSamples,
} from './services/db-writer.js';
import { assumeRole } from '../discovery/services/sts-service.js';
import { writeAuditLog } from '../discovery/services/audit-service.js';
import { fetchAsgPolicySnapshots, fetchEcsPolicySnapshots, upsertPolicySnapshots } from './services/policy-snapshot.js';
import { fetchScalingEnrichment } from '../../lib/cloudwatch-client.js';
import { fetchAsgActivities } from './services/asg-client.js';
import { fetchEcsScalingActivities } from './services/app-autoscaling-client.js';
import { fetchCloudTrailCapacityChanges } from './services/cloudtrail-client.js';
import { fetchRdsStorageAutoscalingEvents } from './services/rds-events-client.js';
import { fetchRdsCloudTrailCapacityChanges } from './services/rds-cloudtrail-client.js';
import { fetchDocDbEvents } from './services/docdb-events-client.js';
import { fetchDocDbCloudTrailCapacityChanges } from './services/docdb-cloudtrail-client.js';
import { fetchMskOperations } from './services/msk-operations-client.js';
import { fetchMskCloudTrailCapacityChanges } from './services/msk-cloudtrail-client.js';
import { fetchElastiCacheCloudTrailCapacityChanges } from './services/elasticache-cloudtrail-client.js';
import { fetchDirectConnectConnections, fetchVpnTunnels } from './services/network-client.js';
import { fetchNetworkUtilization } from './services/network-cloudwatch-client.js';

const ACCOUNT = {
    id: 'acc-1',
    tenantId: 'tenant-1',
    accountId: '111111111111',
    name: 'Test Account',
    roleArn: 'arn:aws:iam::111111111111:role/NucleusAccess-hub',
    externalId: 'ext-1',
    regions: ['ap-south-1'],
    active: true,
};
const ASSUMED = { credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }, region: 'ap-south-1' };
const EMPTY_POLL_OUTCOME = { events: [], apiCallCount: 0, pagesFetched: 0, truncated: false, oldestActivitySeenAt: null, newestActivitySeenAt: null };
const EMPTY_CLOUDTRAIL_OUTCOME = { ...EMPTY_POLL_OUTCOME, retentionClamped: false, platformSkipped: 0 };

describe('handleScan — scope + Network Pulse orchestration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getScalingAuditEligibleAccounts).mockResolvedValue([ACCOUNT] as any);
        vi.mocked(createRun).mockResolvedValue('run-1');
        vi.mocked(finishRun).mockResolvedValue(undefined);
        vi.mocked(hasCompletedRun).mockResolvedValue(true);
        vi.mocked(hasActiveRun).mockResolvedValue(false);
        vi.mocked(getWatermark).mockResolvedValue({ lastActivityAt: null, lastActivityId: null } as any);
        vi.mocked(createCoverageRow).mockResolvedValue('coverage-1');
        vi.mocked(updateCoverageRow).mockResolvedValue(undefined);
        vi.mocked(upsertWatermark).mockResolvedValue(undefined);
        vi.mocked(getInventoryResourceIds).mockResolvedValue(new Set());
        vi.mocked(insertEvents).mockResolvedValue(0);
        vi.mocked(upsertNetworkLinkSamples).mockResolvedValue(0);
        vi.mocked(assumeRole).mockResolvedValue(ASSUMED as any);
        vi.mocked(writeAuditLog).mockResolvedValue(undefined as any);
        vi.mocked(fetchAsgPolicySnapshots).mockResolvedValue([]);
        vi.mocked(fetchEcsPolicySnapshots).mockResolvedValue([]);
        vi.mocked(upsertPolicySnapshots).mockResolvedValue(0);
        vi.mocked(fetchScalingEnrichment).mockResolvedValue(new Map());
        vi.mocked(fetchAsgActivities).mockResolvedValue(EMPTY_POLL_OUTCOME as any);
        vi.mocked(fetchEcsScalingActivities).mockResolvedValue(EMPTY_POLL_OUTCOME as any);
        vi.mocked(fetchCloudTrailCapacityChanges).mockResolvedValue(EMPTY_CLOUDTRAIL_OUTCOME as any);
        vi.mocked(fetchRdsStorageAutoscalingEvents).mockResolvedValue(EMPTY_POLL_OUTCOME as any);
        vi.mocked(fetchRdsCloudTrailCapacityChanges).mockResolvedValue(EMPTY_CLOUDTRAIL_OUTCOME as any);
        vi.mocked(fetchDocDbEvents).mockResolvedValue(EMPTY_POLL_OUTCOME as any);
        vi.mocked(fetchDocDbCloudTrailCapacityChanges).mockResolvedValue(EMPTY_CLOUDTRAIL_OUTCOME as any);
        vi.mocked(fetchMskOperations).mockResolvedValue(EMPTY_POLL_OUTCOME as any);
        vi.mocked(fetchMskCloudTrailCapacityChanges).mockResolvedValue(EMPTY_CLOUDTRAIL_OUTCOME as any);
        vi.mocked(fetchElastiCacheCloudTrailCapacityChanges).mockResolvedValue(EMPTY_CLOUDTRAIL_OUTCOME as any);
        vi.mocked(fetchDirectConnectConnections).mockResolvedValue([]);
        vi.mocked(fetchVpnTunnels).mockResolvedValue([]);
        vi.mocked(fetchNetworkUtilization).mockResolvedValue(new Map());
    });

    it('polls all 6 scopes — not just asg/ecs — via their aws_api and/or cloudtrail fetchers', async () => {
        await handleScan({ tenantId: 'tenant-1', trigger: 'manual' });

        // aws_api sources (elasticache has none — cloudtrail is its sole source).
        expect(fetchAsgActivities).toHaveBeenCalledWith(ASSUMED, 'ap-south-1', null);
        expect(fetchEcsScalingActivities).toHaveBeenCalledWith(ASSUMED, 'ap-south-1', null);
        expect(fetchRdsStorageAutoscalingEvents).toHaveBeenCalledWith(ASSUMED, 'ap-south-1', null);
        expect(fetchDocDbEvents).toHaveBeenCalledWith(ASSUMED, 'ap-south-1', null, expect.any(Date));
        expect(fetchMskOperations).toHaveBeenCalledWith(ASSUMED, 'ap-south-1', null);

        // cloudtrail sources — ecs/asg share one sweep; the rest have their own.
        expect(fetchCloudTrailCapacityChanges).toHaveBeenCalledWith(ASSUMED, 'ap-south-1', null, expect.any(Date), ACCOUNT.roleArn);
        expect(fetchRdsCloudTrailCapacityChanges).toHaveBeenCalledWith(ASSUMED, 'ap-south-1', null, expect.any(Date), ACCOUNT.roleArn);
        expect(fetchDocDbCloudTrailCapacityChanges).toHaveBeenCalledWith(ASSUMED, 'ap-south-1', null, expect.any(Date), ACCOUNT.roleArn);
        expect(fetchMskCloudTrailCapacityChanges).toHaveBeenCalledWith(ASSUMED, 'ap-south-1', null, expect.any(Date), ACCOUNT.roleArn);
        expect(fetchElastiCacheCloudTrailCapacityChanges).toHaveBeenCalledWith(ASSUMED, 'ap-south-1', null, expect.any(Date), ACCOUNT.roleArn);

        expect(finishRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'completed' }));
    });

    it('runs the Network Pulse (DX/VPN) collection step for the account/region', async () => {
        await handleScan({ tenantId: 'tenant-1', trigger: 'manual' });

        expect(fetchDirectConnectConnections).toHaveBeenCalledWith(ASSUMED, 'ap-south-1');
        expect(fetchVpnTunnels).toHaveBeenCalledWith(ASSUMED, 'ap-south-1');
    });

    // Regression: GetMetricData's hourly buckets are anchored to the query's
    // endTime, not a fixed wall-clock grid. Passing the exact scan-run moment
    // (whatever minute it happens to be) shifts the whole bucket grid on every
    // re-scan, so the upsert's ON CONFLICT (…, bucketStartUtc) never matches
    // an existing row — every re-scan adds a fresh, differently-offset set of
    // "hourly" rows for the same real hours instead of refreshing them, which
    // is exactly what inflated the DX availability report past 100% in prod.
    it('rounds the Network Pulse window down to the current UTC hour, so repeat scans reuse the same bucket grid', async () => {
        vi.mocked(fetchDirectConnectConnections).mockResolvedValue([{ resourceId: 'dxcon-1', virtualInterfaceIds: [] }]);
        await handleScan({ tenantId: 'tenant-1', trigger: 'manual' });

        const [, , , startTime, endTime] = vi.mocked(fetchNetworkUtilization).mock.calls[0];
        expect(endTime.getUTCMinutes()).toBe(0);
        expect(endTime.getUTCSeconds()).toBe(0);
        expect(endTime.getUTCMilliseconds()).toBe(0);
        expect(startTime.getUTCMinutes()).toBe(0);
        expect(startTime.getUTCSeconds()).toBe(0);
    });

    it('upserts network link samples built from discovered DX connections + CloudWatch buckets', async () => {
        vi.mocked(fetchDirectConnectConnections).mockResolvedValue([
            { resourceId: 'dxcon-1', name: 'Primary', displayName: 'HQ', installedBandwidthMbps: 1000 },
        ]);
        const bucket = { bucketStartUtc: new Date('2026-08-17T10:00:00Z'), bpsAvgIn: 10, bpsMaxIn: 20, bpsAvgOut: 30, bpsMaxOut: 40, stateUp: true };
        vi.mocked(fetchNetworkUtilization).mockResolvedValue(new Map([['dxcon-1', [bucket]]]));

        await handleScan({ tenantId: 'tenant-1', trigger: 'manual' });

        expect(upsertNetworkLinkSamples).toHaveBeenCalledWith(
            'tenant-1',
            expect.arrayContaining([
                expect.objectContaining({
                    accountId: '111111111111',
                    region: 'ap-south-1',
                    resourceType: 'dx_connection',
                    resourceId: 'dxcon-1',
                    displayName: 'HQ',
                    bpsAvgIn: 10,
                    bpsMaxOut: 40,
                    bucketStartUtc: bucket.bucketStartUtc,
                }),
            ])
        );
    });

    it('a Network Pulse discovery failure does NOT prevent scope polling from completing', async () => {
        vi.mocked(fetchDirectConnectConnections).mockRejectedValue(new Error('DX describe failed'));

        await expect(handleScan({ tenantId: 'tenant-1', trigger: 'manual' })).resolves.toBeUndefined();

        // Every scope fetcher still ran despite the network step blowing up.
        expect(fetchAsgActivities).toHaveBeenCalled();
        expect(fetchRdsStorageAutoscalingEvents).toHaveBeenCalled();
        expect(fetchElastiCacheCloudTrailCapacityChanges).toHaveBeenCalled();
        // Swallowed, not surfaced as a scan error — same posture as the policy
        // snapshot's best-effort enrichment.
        expect(finishRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'completed' }));
    });

    it('a Network Pulse CloudWatch failure does NOT prevent scope polling from completing', async () => {
        vi.mocked(fetchDirectConnectConnections).mockResolvedValue([{ resourceId: 'dxcon-1', installedBandwidthMbps: 1000 }]);
        vi.mocked(fetchNetworkUtilization).mockRejectedValue(new Error('GetMetricData failed'));

        await expect(handleScan({ tenantId: 'tenant-1', trigger: 'manual' })).resolves.toBeUndefined();

        expect(fetchEcsScalingActivities).toHaveBeenCalled();
        expect(upsertNetworkLinkSamples).not.toHaveBeenCalled();
        expect(finishRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'completed' }));
    });
});

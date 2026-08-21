// web-ui/lib/network-availability-report.test.ts
//
// TDD: written before network-availability-report.ts exists. Exercises the
// "Direct Connect & VPN" compliance report — one DX connection + two VPN
// backup tunnels across a 24-hour window (hourly buckets), with a down-hour
// on each resource individually and one hour where ALL THREE are down
// simultaneously (the only hour that should drag the "combined" redundancy
// row below 100%). Every number below was hand-computed and cross-checked
// with a node one-liner (date-fns-tz + toFixed) before being pasted in, so
// this is a real red->green fixture, not a snapshot of whatever the code
// produced.
import { describe, it, expect } from 'vitest';
import { buildNetworkAvailabilityReport } from './network-availability-report';
import type { NetworkLinkSample } from './db/repositories/network-links/interface';

const TENANT = 'tenant-1';
const ACCOUNT = '111111111111';
const REGION = 'ap-south-1';

const WINDOW_START = new Date('2026-04-13T00:00:00.000Z');
const WINDOW_END = new Date('2026-04-14T00:00:00.000Z'); // 24 hourly buckets

function hourUtc(h: number): Date {
    return new Date(`2026-04-13T${String(h).padStart(2, '0')}:00:00.000Z`);
}

function baseSample(overrides: Partial<NetworkLinkSample>): NetworkLinkSample {
    return {
        tenantId: TENANT,
        accountId: ACCOUNT,
        region: REGION,
        resourceType: 'dx_connection',
        resourceId: 'placeholder',
        displayName: null,
        installedBandwidthMbps: null,
        bpsAvgIn: null,
        bpsMaxIn: null,
        bpsAvgOut: null,
        bpsMaxOut: null,
        stateUp: null,
        bucketStartUtc: WINDOW_START,
        ...overrides,
    };
}

// DX: down at h3 and h15. Constant avg traffic (1.6707% in / 0.0868% out of
// its 1 Gbps installed capacity). A single burst at h20 (75.50%) is both its
// peak AND its only >70% breach.
const dxSamples: NetworkLinkSample[] = Array.from({ length: 24 }, (_, h) =>
    baseSample({
        resourceType: 'dx_connection',
        resourceId: 'dxcon-abc123',
        displayName: null,
        installedBandwidthMbps: 1000,
        bpsAvgIn: 16_707_000,
        bpsAvgOut: 868_000,
        bpsMaxIn: h === 20 ? 755_000_000 : 5_000_000,
        bpsMaxOut: 1_000_000,
        stateUp: !(h === 3 || h === 15),
        bucketStartUtc: hourUtc(h),
    })
);

// Samples outside [WINDOW_START, WINDOW_END) must be ignored. Both carry
// extreme values that would change every DX figure (uptime, peak, breach
// count) if the window boundary were handled wrong — one hour before the
// start, one exactly AT the (exclusive) end.
const dxOutOfWindow: NetworkLinkSample[] = [
    baseSample({
        resourceType: 'dx_connection',
        resourceId: 'dxcon-abc123',
        installedBandwidthMbps: 1000,
        bpsMaxIn: 999_000_000,
        bpsMaxOut: 0,
        stateUp: false,
        bucketStartUtc: new Date('2026-04-12T23:00:00.000Z'),
    }),
    baseSample({
        resourceType: 'dx_connection',
        resourceId: 'dxcon-abc123',
        installedBandwidthMbps: 1000,
        bpsMaxIn: 999_000_000,
        bpsMaxOut: 0,
        stateUp: false,
        bucketStartUtc: WINDOW_END,
    }),
];

// VPN "AIRTEL VPN": down at h10 and h15, near-idle traffic, peak at h8
// (0.24%), no breach.
const vpn1Samples: NetworkLinkSample[] = Array.from({ length: 24 }, (_, h) =>
    baseSample({
        resourceType: 'vpn_tunnel',
        resourceId: 'vpn-111:1.2.3.4',
        displayName: 'AIRTEL VPN',
        installedBandwidthMbps: 1250,
        bpsAvgIn: 1250,
        bpsAvgOut: 0,
        bpsMaxIn: h === 8 ? 3_000_000 : 1_000,
        bpsMaxOut: 500,
        stateUp: !(h === 10 || h === 15),
        bucketStartUtc: hourUtc(h),
    })
);

// VPN "TATA VPN": down at h10 and h15 (same hours as AIRTEL — together with
// DX's h15 down-hour, h15 is the ONE hour all three links are down, which is
// what should pull the combined-availability row below 100%). Two breach
// hours (h6 at 70.08%, h14 at 80.00% — the peak).
const vpn2Samples: NetworkLinkSample[] = Array.from({ length: 24 }, (_, h) =>
    baseSample({
        resourceType: 'vpn_tunnel',
        resourceId: 'vpn-222:5.6.7.8',
        displayName: 'TATA VPN',
        installedBandwidthMbps: 1250,
        bpsAvgIn: 668_750,
        bpsAvgOut: 46_250,
        bpsMaxIn: h === 14 ? 1_000_000_000 : h === 6 ? 876_000_000 : 50_000_000,
        bpsMaxOut: 100_000,
        stateUp: !(h === 10 || h === 15),
        bucketStartUtc: hourUtc(h),
    })
);

const allSamples: NetworkLinkSample[] = [
    ...dxSamples,
    ...dxOutOfWindow,
    ...vpn1Samples,
    ...vpn2Samples,
];

describe('buildNetworkAvailabilityReport', () => {
    it('computes the DX-only, combined, and per-link bandwidth rows exactly', () => {
        const rows = buildNetworkAvailabilityReport(allSamples, WINDOW_START, WINDOW_END);

        expect(rows).toEqual([
            {
                particulars: 'Network availability — DX only',
                installedCapacity: '100%',
                utilisedCapacity: '91.67%',
                peakLoad: 'N/A',
                breachCount: null,
            },
            {
                particulars: 'Network availability — DX + VPN backup combined',
                installedCapacity: '100% (redundant paths)',
                utilisedCapacity: '95.8333%',
                peakLoad: 'N/A',
                breachCount: null,
            },
            {
                particulars: 'Bandwidth — dxcon-abc123 (primary)',
                installedCapacity: '1 Gbps',
                utilisedCapacity:
                    'Avg Ingress 1.6707% (16.71 Mbps) / Avg Egress 0.0868% (0.87 Mbps)',
                peakLoad: '75.50% (755.00 Mbps, Ingress) on 14-Apr-2026 01:30 IST',
                breachCount: 1,
            },
            {
                particulars: 'Bandwidth — AIRTEL VPN (backup)',
                installedCapacity: '1.25 Gbps',
                utilisedCapacity:
                    'Avg Ingress 0.0001% (0.00 Mbps) / Avg Egress 0.0000% (0.00 Mbps)',
                peakLoad: '0.24% (3.00 Mbps, Ingress) on 13-Apr-2026 13:30 IST',
                breachCount: 0,
            },
            {
                particulars: 'Bandwidth — TATA VPN (backup)',
                installedCapacity: '1.25 Gbps',
                utilisedCapacity:
                    'Avg Ingress 0.0535% (0.67 Mbps) / Avg Egress 0.0037% (0.05 Mbps)',
                peakLoad: '80.00% (1000.00 Mbps, Ingress) on 13-Apr-2026 19:30 IST',
                breachCount: 2,
            },
        ]);
    });

    it('returns an empty array when there are no samples at all', () => {
        expect(buildNetworkAvailabilityReport([], WINDOW_START, WINDOW_END)).toEqual([]);
    });

    it('renders DX-only as N/A (not 0%) when no dx_connection resource is present, and still formats sub-1000 Mbps as Mbps', () => {
        const start = new Date('2026-01-01T00:00:00.000Z');
        const end = new Date('2026-01-01T02:00:00.000Z'); // 2 hourly buckets

        const soloVpn: NetworkLinkSample[] = [
            baseSample({
                resourceType: 'vpn_tunnel',
                resourceId: 'vpn-999:9.9.9.9',
                displayName: 'SoloVPN',
                installedBandwidthMbps: 400,
                bpsAvgIn: 40_000_000,
                bpsAvgOut: 0,
                bpsMaxIn: 100_000_000,
                bpsMaxOut: 0,
                stateUp: true,
                bucketStartUtc: new Date('2026-01-01T00:00:00.000Z'),
            }),
            baseSample({
                resourceType: 'vpn_tunnel',
                resourceId: 'vpn-999:9.9.9.9',
                displayName: 'SoloVPN',
                installedBandwidthMbps: 400,
                bpsAvgIn: 40_000_000,
                bpsAvgOut: 0,
                bpsMaxIn: 360_000_000, // 90% of 400 Mbps — breach, and the peak
                bpsMaxOut: 0,
                stateUp: true,
                bucketStartUtc: new Date('2026-01-01T01:00:00.000Z'),
            }),
        ];

        expect(buildNetworkAvailabilityReport(soloVpn, start, end)).toEqual([
            {
                particulars: 'Network availability — DX only',
                installedCapacity: '100%',
                utilisedCapacity: 'N/A',
                peakLoad: 'N/A',
                breachCount: null,
            },
            {
                particulars: 'Network availability — DX + VPN backup combined',
                installedCapacity: '100% (redundant paths)',
                utilisedCapacity: '100.0000%',
                peakLoad: 'N/A',
                breachCount: null,
            },
            {
                particulars: 'Bandwidth — SoloVPN (backup)',
                installedCapacity: '400 Mbps',
                utilisedCapacity:
                    'Avg Ingress 10.0000% (40.00 Mbps) / Avg Egress 0.0000% (0.00 Mbps)',
                peakLoad: '90.00% (360.00 Mbps, Ingress) on 01-Jan-2026 06:30 IST',
                breachCount: 1,
            },
        ]);
    });
});

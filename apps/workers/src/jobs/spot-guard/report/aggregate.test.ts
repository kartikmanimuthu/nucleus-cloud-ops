// workers/src/jobs/spot-guard/report/aggregate.test.ts
//
// Tests for the pure report folding and Slack formatting. The interval clipping itself is
// SQL and is covered by report.integration.test.ts against a real Postgres — including
// the midnight-split and in-flight cases, which are the two the reference got wrong.
import { describe, it, expect } from 'vitest';
import { aggregateHours, formatSlackDigest, spotShareOf, toHours } from './aggregate.js';
import type { HoursRow } from './query.js';

const FROM = new Date('2026-07-20T00:00:00Z');
const TO = new Date('2026-07-21T00:00:00Z');

const row = (over: Partial<HoursRow> = {}): HoursRow => ({
    accountId: '111111111111',
    region: 'ap-south-1',
    clusterName: 'cluster-a',
    serviceName: 'api',
    capacityType: 'spot',
    seconds: 3600,
    sessions: 1,
    inFlightSessions: 0,
    interruptions: 0,
    ...over,
});

describe('toHours / spotShareOf', () => {
    it('converts seconds to hours at two decimals', () => {
        expect(toHours(3600)).toBe(1);
        expect(toHours(5400)).toBe(1.5);
        expect(toHours(1234)).toBe(0.34);
    });

    it('returns 0 share when there is no running time, rather than NaN', () => {
        // 0/0 would be NaN and would poison every total above it.
        expect(spotShareOf(0, 0)).toBe(0);
    });

    it('computes share over total running time', () => {
        expect(spotShareOf(3600, 1200)).toBe(0.75);
        expect(spotShareOf(3600, 0)).toBe(1);
        expect(spotShareOf(0, 3600)).toBe(0);
    });
});

describe('aggregateHours', () => {
    it('merges the spot and on-demand rows for one service', () => {
        const r = aggregateHours(
            [row({ capacityType: 'spot', seconds: 3600 }), row({ capacityType: 'on_demand', seconds: 1800 })],
            { from: FROM, to: TO },
        );
        const svc = r.accounts[0].clusters[0].services[0];
        expect(svc.spotHours).toBe(1);
        expect(svc.onDemandHours).toBe(0.5);
        expect(svc.spotShare).toBeCloseTo(0.6667, 3);
    });

    it('does NOT merge same-named clusters from different regions', () => {
        // Merging would silently double a service's hours.
        const r = aggregateHours(
            [row({ region: 'ap-south-1' }), row({ region: 'us-east-1' })],
            { from: FROM, to: TO },
        );
        expect(r.accounts[0].clusters).toHaveLength(2);
        expect(r.accounts[0].clusters.map((c) => c.region)).toEqual(['ap-south-1', 'us-east-1']);
    });

    it('nests multiple accounts, clusters and services', () => {
        const r = aggregateHours(
            [
                row({ accountId: '111111111111', clusterName: 'c1', serviceName: 'api' }),
                row({ accountId: '111111111111', clusterName: 'c1', serviceName: 'worker' }),
                row({ accountId: '111111111111', clusterName: 'c2', serviceName: 'api' }),
                row({ accountId: '222222222222', clusterName: 'c3', serviceName: 'api' }),
            ],
            { from: FROM, to: TO },
        );
        expect(r.accounts).toHaveLength(2);
        expect(r.accounts[0].clusters).toHaveLength(2);
        expect(r.accounts[0].clusters[0].services.map((s) => s.serviceName)).toEqual(['api', 'worker']);
    });

    it('resolves account display names, falling back to the id', () => {
        // Nucleus already stores the name on the accounts row. The reference needed a whole
        // DynamoDB table plus a CloudFormation custom-resource seeder for this, because
        // organizations:DescribeAccount only works from an Org management account.
        const r = aggregateHours([row(), row({ accountId: '222222222222' })], {
            from: FROM,
            to: TO,
            accountNames: { '111111111111': 'Production' },
        });
        expect(r.accounts[0].accountName).toBe('Production');
        expect(r.accounts[1].accountName).toBe('222222222222');
    });

    it('sorts deterministically so two runs diff cleanly', () => {
        const r = aggregateHours(
            [
                row({ accountId: '999999999999', clusterName: 'zeta', serviceName: 'zzz' }),
                row({ accountId: '111111111111', clusterName: 'alpha', serviceName: 'aaa' }),
            ],
            { from: FROM, to: TO },
        );
        expect(r.accounts.map((a) => a.accountId)).toEqual(['111111111111', '999999999999']);
    });

    it('rolls totals up across every level', () => {
        const r = aggregateHours(
            [
                row({ capacityType: 'spot', seconds: 3600, sessions: 2, interruptions: 1 }),
                row({ accountId: '222222222222', capacityType: 'on_demand', seconds: 7200, sessions: 3 }),
            ],
            { from: FROM, to: TO },
        );
        expect(r.totals.spotHours).toBe(1);
        expect(r.totals.onDemandHours).toBe(2);
        expect(r.totals.sessions).toBe(5);
        expect(r.totals.interruptions).toBe(1);
        expect(r.totals.spotShare).toBeCloseTo(0.3333, 3);
    });

    it('carries in-flight counts through so partial numbers are visible', () => {
        const r = aggregateHours([row({ inFlightSessions: 2, sessions: 3 })], { from: FROM, to: TO });
        expect(r.accounts[0].clusters[0].services[0].inFlightSessions).toBe(2);
        expect(r.totals.inFlightSessions).toBe(2);
    });

    it('reports estimatedSavings as NULL when no rate is supplied, not 0', () => {
        // An unknown saving and a zero saving are different claims; reporting 0 would
        // understate the feature.
        expect(aggregateHours([row()], { from: FROM, to: TO }).totals.estimatedSavings).toBeNull();
    });

    it('computes estimatedSavings from Spot hours when a rate is supplied', () => {
        const r = aggregateHours([row({ seconds: 7200 })], {
            from: FROM,
            to: TO,
            onDemandRatePerHour: 0.1,
            spotDiscount: 0.7,
        });
        // 2 hrs on Spot x $0.10/hr x 70% avoided = $0.14
        expect(r.totals.estimatedSavings).toBeCloseTo(0.14, 2);
    });

    it('handles an empty result set without throwing', () => {
        const r = aggregateHours([], { from: FROM, to: TO });
        expect(r.accounts).toEqual([]);
        expect(r.totals.spotHours).toBe(0);
        expect(r.totals.spotShare).toBe(0);
    });

    it('defaults dataQuality when none is supplied', () => {
        expect(aggregateHours([], { from: FROM, to: TO }).dataQuality).toEqual({ orphaned: 0, staleOpen: 0 });
    });
});

describe('formatSlackDigest', () => {
    const report = aggregateHours(
        [
            row({ capacityType: 'spot', seconds: 7200, sessions: 4, interruptions: 2 }),
            row({ capacityType: 'on_demand', seconds: 1800, sessions: 1 }),
            row({ serviceName: 'worker', capacityType: 'spot', seconds: 3600, inFlightSessions: 1 }),
        ],
        { from: FROM, to: TO, accountNames: { '111111111111': 'Production' } },
    );

    it('renders the Account -> Cluster -> Service hierarchy', () => {
        const out = formatSlackDigest(report, { reportDate: '2026-07-20' });
        expect(out).toContain(':office: *Production*');
        expect(out).toContain(':wheel_of_dharma: *cluster-a*');
        expect(out).toContain(':small_blue_diamond: api');
        expect(out).toContain(':small_blue_diamond: worker');
    });

    it('shows both capacity types and the Spot share per service', () => {
        const out = formatSlackDigest(report, { reportDate: '2026-07-20' });
        expect(out).toContain('Spot 2.00 hrs | On-Demand 0.50 hrs | 80% Spot');
    });

    it('flags in-flight and interrupted sessions inline', () => {
        // A reader looking at one number needs to know part of it is still accruing.
        const out = formatSlackDigest(report, { reportDate: '2026-07-20' });
        expect(out).toContain('2 interrupted');
        expect(out).toContain('1 running');
    });

    it('states an explicit empty message rather than an empty report', () => {
        const empty = aggregateHours([], { from: FROM, to: TO });
        expect(formatSlackDigest(empty, { reportDate: '2026-07-20' })).toContain(
            'No ECS Spot activity recorded for this period.',
        );
    });

    it('appends a data-quality footer when sessions were excluded', () => {
        const withLoss = aggregateHours([row()], {
            from: FROM,
            to: TO,
            dataQuality: { orphaned: 3, staleOpen: 1 },
        });
        const out = formatSlackDigest(withLoss, { reportDate: '2026-07-20' });
        expect(out).toContain('3 session(s) excluded (no start event recorded)');
        expect(out).toContain('1 session(s) still open after 7 days');
    });

    it('omits the footer entirely when data is clean', () => {
        expect(formatSlackDigest(report, { reportDate: '2026-07-20' })).not.toContain('Data quality');
    });

    it('omits the savings line when no rate was supplied', () => {
        expect(formatSlackDigest(report, { reportDate: '2026-07-20' })).not.toContain('Estimated saving');
    });

    it('uses no Slack attachment colours', () => {
        // The reference set "#warning"/"#good", which are neither Slack colour keywords nor
        // hex codes, so they were silently ignored. Not worth reproducing.
        const out = formatSlackDigest(report, { reportDate: '2026-07-20' });
        expect(out).not.toContain('#warning');
        expect(out).not.toContain('#good');
    });
});

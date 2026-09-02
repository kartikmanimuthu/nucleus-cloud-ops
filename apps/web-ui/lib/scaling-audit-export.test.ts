import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
    describeFilters,
    buildCoverageStatement,
    buildWorkbook,
    buildPdf,
    EXPORT_COLUMNS,
    exportTitle,
    buildNetworkCoverageStatement,
    buildNetworkWorkbook,
    buildNetworkPdf,
} from './scaling-audit-export';
import type { ScalingEvent } from './db/repositories/scaling-audit/interface';
import type { NetworkAvailabilityReportRow } from './db/repositories/network-links/interface';

function fixtureEvent(overrides: Partial<ScalingEvent> = {}): ScalingEvent {
    return {
        id: 'evt-1',
        tenantId: 't1',
        accountId: '111111111111',
        region: 'ap-south-1',
        scope: 'asg',
        source: 'aws_api',
        activityId: 'act-1',
        resourceId: 'my-asg',
        inventoryMatched: true,
        scalingType: 'target_tracking',
        cause: 'a target-tracking alarm',
        rawPayload: {},
        desiredBefore: 2,
        desiredAfter: 3,
        actor: 'application-autoscaling.amazonaws.com',
        actorType: 'unattributed_out_of_band',
        startedAt: '2026-08-15T10:00:00.000Z',
        reportDateIst: '2026-08-15',
        capturedByRunId: 'run-1',
        capturedAt: '2026-08-15T10:05:00.000Z',
        ...overrides,
    };
}

function fixtureNetworkRow(overrides: Partial<NetworkAvailabilityReportRow> = {}): NetworkAvailabilityReportRow {
    return {
        particulars: 'Network availability — DX only',
        installedCapacity: '100%',
        utilisedCapacity: '99.9500%',
        peakLoad: 'N/A',
        breachCount: null,
        ...overrides,
    };
}

const TITLE = 'Scale Sentinel Export — SEBI Compliance Record';
const NETWORK_TITLE = exportTitle('network');

describe('describeFilters', () => {
    it('states the date range as the direct answer to "did my range apply"', () => {
        const line = describeFilters({ dateFrom: '2026-08-01', dateTo: '2026-08-15' });
        expect(line).toContain('Date range: 2026-08-01 to 2026-08-15');
        expect(line).toContain('IST calendar days, inclusive');
    });

    it('falls back to "earliest/latest available" when a bound is missing', () => {
        const line = describeFilters({});
        expect(line).toContain('earliest available');
        expect(line).toContain('latest available');
    });

    it('appends every other active filter', () => {
        const line = describeFilters({ scope: 'ecs', accountId: '123', searchTerm: 'foo' });
        expect(line).toContain('scope=ecs');
        expect(line).toContain('account=123');
        expect(line).toContain('search="foo"');
    });
});

describe('exportTitle', () => {
    it('names the scope in the title', () => {
        expect(exportTitle('ecs')).toContain('ECS');
        expect(exportTitle('ecs')).toContain('SEBI Compliance Record');
    });

    it('names the network report distinctly from a scaling scope', () => {
        expect(exportTitle('network')).toContain('Direct Connect & VPN');
    });

    it('falls back to a scope-agnostic label when no scope is set', () => {
        expect(exportTitle(undefined)).toContain('All resource types');
    });
});

describe('buildCoverageStatement', () => {
    it('leads with the applied filters, then states complete-vs-effective-only scope', () => {
        const lines = buildCoverageStatement([], false, null, 'all', { dateFrom: '2026-08-01', dateTo: '2026-08-15' });
        expect(lines[0]).toContain('Filters applied');
        expect(lines.some((l) => l.includes('COMPLETE record'))).toBe(true);
        expect(lines.some((l) => l.includes('No known coverage gaps'))).toBe(true);
    });

    it('warns explicitly when the export was truncated', () => {
        const lines = buildCoverageStatement([], true, null, 'capacity_changes', {});
        expect(lines.some((l) => l.startsWith('WARNING: export row cap reached'))).toBe(true);
    });

    it('lists each known coverage gap with its account/region/scope', () => {
        const lines = buildCoverageStatement(
            [{ accountId: 'acc-1', region: 'us-east-1', scope: 'asg', gapReason: 'AccessDenied', gapFromAt: '2026-08-01T00:00:00Z', gapToAt: '2026-08-02T00:00:00Z' }],
            false, null, 'capacity_changes', {}
        );
        expect(lines.some((l) => l.includes('account=acc-1 region=us-east-1 scope=asg') && l.includes('AccessDenied'))).toBe(true);
    });

    it('shows only the ASG bullet for an ASG-scoped export — an ASG file must not read like an ECS one', () => {
        const lines = buildCoverageStatement([], false, null, 'capacity_changes', { scope: 'asg' });
        const joined = lines.join('\n');
        expect(joined).toContain('ASG (EC2 Auto Scaling)');
        expect(joined).not.toContain('ecs:UpdateService');
    });

    it('shows only the RDS bullet for an RDS-scoped export, not the ASG/ECS bullets', () => {
        const lines = buildCoverageStatement([], false, null, 'capacity_changes', { scope: 'rds' });
        const joined = lines.join('\n');
        expect(joined).toContain('RDS-EVENT-0218');
        expect(joined).not.toContain('ASG (EC2 Auto Scaling)');
        expect(joined).not.toContain('ecs:UpdateService');
    });

    it('shows every scope bullet for a full, unscoped export', () => {
        const lines = buildCoverageStatement([], false, null, 'capacity_changes', {});
        const joined = lines.join('\n');
        expect(joined).toContain('ASG (EC2 Auto Scaling)');
        expect(joined).toContain('RDS-EVENT-0218');
        expect(joined).toContain('ListClusterOperationsV2');
        expect(joined).toContain('ElastiCache');
        expect(joined).toContain('DocumentDB');
    });

    it('states the corrected CloudTrail coverage instead of the stale "not yet implemented" claim', () => {
        const lines = buildCoverageStatement([], false, null, 'capacity_changes', {});
        const joined = lines.join('\n');
        expect(joined).not.toContain('not yet implemented');
        expect(joined).toContain('CloudTrail');
        expect(joined).toContain('identifies the calling principal');
    });
});

describe('buildWorkbook', () => {
    it('produces a real .xlsx with a formatted header and every event row', async () => {
        const events = [fixtureEvent(), fixtureEvent({ id: 'evt-2', resourceId: 'my-asg-2', desiredBefore: 1, desiredAfter: null })];
        const buf = await buildWorkbook(events, ['Filters applied: date range 2026-08-01 to 2026-08-15'], TITLE);

        // Structural round-trip, not just "didn't throw" — re-parse the buffer
        // with the same library and assert on the actual sheet content.
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);

        const notes = wb.getWorksheet('Coverage Notes');
        expect(notes).toBeDefined();
        expect(notes!.getCell('A1').value).toContain('SEBI Compliance Record');

        const sheet = wb.getWorksheet('Events');
        expect(sheet).toBeDefined();
        // Header row: bold, matches the declared column labels in order.
        const headerRow = sheet!.getRow(1);
        expect(headerRow.getCell(1).value).toBe(EXPORT_COLUMNS[0].label);
        expect(headerRow.getCell(1).font?.bold).toBe(true);
        // One data row per event, plus the header.
        expect(sheet!.rowCount).toBe(events.length + 1);
        // A null numeric field renders as a genuinely empty cell, not the string "null".
        const desiredAfterCol = EXPORT_COLUMNS.findIndex((c) => c.key === 'desiredAfter') + 1;
        expect(sheet!.getRow(3).getCell(desiredAfterCol).value).toBeFalsy();
    });

    it('produces a valid, non-empty workbook even with zero events', async () => {
        const buf = await buildWorkbook([], ['No known coverage gaps at export time.'], TITLE);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        expect(wb.getWorksheet('Events')!.rowCount).toBe(1); // header only
    });

    it('titles the Coverage Notes sheet with the scope-aware title, not a hardcoded string', async () => {
        const buf = await buildWorkbook([], [], exportTitle('ecs'));
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        expect(wb.getWorksheet('Coverage Notes')!.getCell('A1').value).toContain('ECS');
    });
});

describe('buildPdf', () => {
    it('produces a well-formed, non-trivial PDF buffer', async () => {
        const buf = await buildPdf([fixtureEvent()], ['Filters applied: date range 2026-08-01 to 2026-08-15'], TITLE);
        expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(buf.length).toBeGreaterThan(1000);
    });

    it('does not throw when there are zero events', async () => {
        const buf = await buildPdf([], ['No known coverage gaps at export time.'], TITLE);
        expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });

    it('spans multiple pages when there are enough rows to overflow one', async () => {
        const events = Array.from({ length: 60 }, (_, i) => fixtureEvent({ id: `evt-${i}`, resourceId: `asg-${i}` }));
        const buf = await buildPdf(events, ['Filters applied: date range 2026-08-01 to 2026-08-15'], TITLE);
        // jsPDF's page objects are enumerable in the raw PDF stream as "/Type /Page" —
        // a cheap, dependency-free way to assert pagination kicked in without
        // pulling in a PDF parser just for a test.
        const pageCount = buf.toString('latin1').split('/Type /Page').length - 1;
        expect(pageCount).toBeGreaterThan(1);
    });
});

describe('buildNetworkCoverageStatement', () => {
    it('states the applied filters, including scope=network', () => {
        const lines = buildNetworkCoverageStatement({ scope: 'network', dateFrom: '2026-08-01', dateTo: '2026-08-15' }, 4);
        expect(lines[0]).toContain('Filters applied');
        expect(lines[0]).toContain('scope=network');
    });

    it('flags an empty result set explicitly rather than leaving it implicit', () => {
        const lines = buildNetworkCoverageStatement({ scope: 'network', dateFrom: '2026-08-01', dateTo: '2026-08-15' }, 0);
        expect(lines.some((l) => l.includes('No network link samples were recorded'))).toBe(true);
    });

    it('notes that the scaling-audit tamper-evidence seal does not cover this report', () => {
        const lines = buildNetworkCoverageStatement({ scope: 'network', dateFrom: '2026-08-01', dateTo: '2026-08-15' }, 4);
        expect(lines.some((l) => l.toLowerCase().includes('seal') && l.toLowerCase().includes('does not'))).toBe(true);
    });
});

describe('buildNetworkWorkbook', () => {
    it('renders the 5-column availability/bandwidth table with one row per input row', async () => {
        const rows = [
            fixtureNetworkRow(),
            fixtureNetworkRow({
                particulars: 'Bandwidth — dxcon-abc (primary)',
                installedCapacity: '1 Gbps',
                utilisedCapacity: 'Avg Ingress 12.3400% (123.40 Mbps) / Avg Egress 1.2300% (12.30 Mbps)',
                peakLoad: '45.67% (456.70 Mbps, Ingress) on 13-Apr-2026 14:30 IST',
                breachCount: 2,
            }),
        ];
        const buf = await buildNetworkWorkbook(rows, ['Filters applied: scope=network'], NETWORK_TITLE);

        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);

        const notes = wb.getWorksheet('Coverage Notes');
        expect(notes).toBeDefined();
        expect(notes!.getCell('A1').value).toContain('Direct Connect & VPN');

        const sheet = wb.getWorksheet('Network Availability');
        expect(sheet).toBeDefined();
        const headerRow = sheet!.getRow(1);
        expect(headerRow.getCell(1).value).toBe('Particulars');
        expect(headerRow.getCell(5).value).toBe('No. of instances >70%');
        expect(sheet!.rowCount).toBe(rows.length + 1);
        // breachCount: null renders as the string 'N/A', never blank or zero.
        expect(sheet!.getRow(2).getCell(5).value).toBe('N/A');
        expect(sheet!.getRow(3).getCell(5).value).toBe(2);
    });

    it('produces a valid, non-empty workbook even with zero rows', async () => {
        const buf = await buildNetworkWorkbook([], ['No network link samples were recorded in this window.'], NETWORK_TITLE);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        expect(wb.getWorksheet('Network Availability')!.rowCount).toBe(1); // header only
    });
});

describe('buildNetworkPdf', () => {
    it('produces a well-formed, non-trivial PDF buffer', async () => {
        const buf = await buildNetworkPdf([fixtureNetworkRow()], ['Filters applied: scope=network'], NETWORK_TITLE);
        expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(buf.length).toBeGreaterThan(1000);
    });

    it('does not throw when there are zero rows, and renders the empty-state line', async () => {
        const buf = await buildNetworkPdf([], ['No network link samples were recorded in this window.'], NETWORK_TITLE);
        expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(buf.toString('latin1')).toContain('No network link samples');
    });

    it('does not truncate a long utilisedCapacity value — the full text survives in the rendered PDF', async () => {
        // buildPdf's own truncateToWidth (a fixed ~column-width character cutoff)
        // would have cut this well before the second percentage — its full,
        // untruncated presence in the raw content stream is the direct proof
        // the network renderer wraps this column instead of cutting it.
        const longValue = 'Avg Ingress 0.123456% (1.23 Mbps) / Avg Egress 0.567890% (5.68 Mbps)';
        const buf = await buildNetworkPdf([fixtureNetworkRow({ utilisedCapacity: longValue })], [], NETWORK_TITLE);
        expect(buf.toString('latin1')).toContain('0.567890');
    });
});

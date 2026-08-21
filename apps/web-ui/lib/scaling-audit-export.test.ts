import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { describeFilters, buildCoverageStatement, buildWorkbook, buildPdf, EXPORT_COLUMNS } from './scaling-audit-export';
import type { ScalingEvent } from './db/repositories/scaling-audit/interface';

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
});

describe('buildWorkbook', () => {
    it('produces a real .xlsx with a formatted header and every event row', async () => {
        const events = [fixtureEvent(), fixtureEvent({ id: 'evt-2', resourceId: 'my-asg-2', desiredBefore: 1, desiredAfter: null })];
        const buf = await buildWorkbook(events, ['Filters applied: date range 2026-08-01 to 2026-08-15']);

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
        const buf = await buildWorkbook([], ['No known coverage gaps at export time.']);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        expect(wb.getWorksheet('Events')!.rowCount).toBe(1); // header only
    });
});

describe('buildPdf', () => {
    it('produces a well-formed, non-trivial PDF buffer', async () => {
        const buf = await buildPdf([fixtureEvent()], ['Filters applied: date range 2026-08-01 to 2026-08-15']);
        expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(buf.length).toBeGreaterThan(1000);
    });

    it('does not throw when there are zero events', async () => {
        const buf = await buildPdf([], ['No known coverage gaps at export time.']);
        expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });

    it('spans multiple pages when there are enough rows to overflow one', async () => {
        const events = Array.from({ length: 60 }, (_, i) => fixtureEvent({ id: `evt-${i}`, resourceId: `asg-${i}` }));
        const buf = await buildPdf(events, ['Filters applied: date range 2026-08-01 to 2026-08-15']);
        // jsPDF's page objects are enumerable in the raw PDF stream as "/Type /Page" —
        // a cheap, dependency-free way to assert pagination kicked in without
        // pulling in a PDF parser just for a test.
        const pageCount = buf.toString('latin1').split('/Type /Page').length - 1;
        expect(pageCount).toBeGreaterThan(1);
    });
});

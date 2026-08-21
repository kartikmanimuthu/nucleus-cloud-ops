import { formatInTimeZone } from 'date-fns-tz';
import ExcelJS from 'exceljs';
import type { ScalingEffectFilter, ScalingEvent, ScalingScope, ScalingSource, ScalingType } from '@/lib/db/repositories/scaling-audit/interface';

/**
 * Excel/PDF rendering for the Scale Sentinel export (`/api/scaling-audit/export`).
 * Kept out of the route file so the actual formatting logic is unit-testable
 * without exercising Next.js request/response plumbing — the route stays a
 * thin handler: parse body, fetch data, call these, return the buffer.
 */

// SEBI is India-based — every timestamp in this compliance record is IST, not
// UTC or whatever ran the export. Imports date-fns-tz directly rather than
// lib/date-utils.ts's wrapper: that module is "use client" (a React Server
// Component boundary marker), and this runs in a plain server context, not a
// component — going straight to the underlying library sidesteps the boundary
// question entirely instead of relying on it happening to work.
export function istTimestamp(input: string | null | undefined): string {
    if (!input) return 'unknown';
    return formatInTimeZone(new Date(input), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
}

export interface ExportFilters {
    accountId?: string;
    region?: string;
    scope?: ScalingScope;
    source?: ScalingSource;
    scalingType?: ScalingType;
    resourceId?: string;
    searchTerm?: string;
    effect?: ScalingEffectFilter;
    dateFrom?: string;
    dateTo?: string;
}

// Single source of truth for column order/labels/widths, shared by the Excel
// sheet and (a curated subset of it) the PDF table — one place to add a
// column instead of two. `description`/`statusMessage` carry the capacity
// semantics for ECS rows — Application Auto Scaling puts the actual change in
// the description ("Setting desired count to 2.") while the cause names only
// the trigger, so a report without them cannot show what an ECS event did.
const NUMERIC_KEYS = new Set<keyof ScalingEvent>([
    'desiredBefore', 'desiredAfter', 'minBefore', 'maxBefore', 'minAfter', 'maxAfter',
    'peakCpuBeforeScale', 'peakMemoryBeforeScale',
]);

export const EXPORT_COLUMNS: Array<{ key: keyof ScalingEvent; label: string; width: number }> = [
    { key: 'startedAt', label: 'startedAt (IST)', width: 20 },
    { key: 'scope', label: 'scope', width: 12 },
    { key: 'source', label: 'source', width: 12 },
    { key: 'scalingType', label: 'scalingType', width: 16 },
    { key: 'accountId', label: 'accountId', width: 16 },
    { key: 'region', label: 'region', width: 14 },
    { key: 'resourceId', label: 'resourceId', width: 32 },
    { key: 'asgName', label: 'asgName', width: 24 },
    { key: 'clusterName', label: 'clusterName', width: 24 },
    { key: 'serviceName', label: 'serviceName', width: 24 },
    { key: 'desiredBefore', label: 'desiredBefore', width: 12 },
    { key: 'desiredAfter', label: 'desiredAfter', width: 12 },
    { key: 'desiredBeforeSource', label: 'desiredBeforeSource', width: 18 },
    { key: 'minBefore', label: 'minBefore', width: 10 },
    { key: 'maxBefore', label: 'maxBefore', width: 10 },
    { key: 'minAfter', label: 'minAfter', width: 10 },
    { key: 'maxAfter', label: 'maxAfter', width: 10 },
    { key: 'peakCpuBeforeScale', label: 'peakCpuBeforeScale', width: 17 },
    { key: 'peakMemoryBeforeScale', label: 'peakMemoryBeforeScale', width: 19 },
    { key: 'statusCode', label: 'statusCode', width: 12 },
    { key: 'notScaledCode', label: 'notScaledCode', width: 20 },
    { key: 'policyName', label: 'policyName', width: 24 },
    { key: 'scheduledActionName', label: 'scheduledActionName', width: 24 },
    { key: 'alarmName', label: 'alarmName', width: 24 },
    { key: 'actor', label: 'actor', width: 32 },
    { key: 'actorType', label: 'actorType', width: 16 },
    { key: 'initiatedBy', label: 'initiatedBy', width: 20 },
    { key: 'activityId', label: 'activityId', width: 26 },
    { key: 'cause', label: 'cause', width: 50 },
    { key: 'description', label: 'description', width: 50 },
    { key: 'statusMessage', label: 'statusMessage', width: 40 },
];

export function cellValue(e: ScalingEvent, key: keyof ScalingEvent): string | number {
    if (key === 'startedAt') return istTimestamp(e.startedAt);
    const v = e[key] as unknown;
    if (v === null || v === undefined) return '';
    return NUMERIC_KEYS.has(key) ? (v as number) : String(v);
}

// States exactly which rows are in the file — the direct answer to "did my
// date range actually apply". `dateFrom`/`dateTo` are IST calendar days,
// inclusive on both ends (see lib/ist-date-range.ts for why that's not the
// same as naive UTC-midnight parsing).
export function describeFilters(f: ExportFilters): string {
    const parts = [`Date range: ${f.dateFrom ?? 'earliest available'} to ${f.dateTo ?? 'latest available'} (IST calendar days, inclusive)`];
    if (f.scope) parts.push(`scope=${f.scope}`);
    if (f.accountId) parts.push(`account=${f.accountId}`);
    if (f.region) parts.push(`region=${f.region}`);
    if (f.source) parts.push(`source=${f.source}`);
    if (f.scalingType) parts.push(`scalingType=${f.scalingType}`);
    if (f.resourceId) parts.push(`resourceId=${f.resourceId}`);
    if (f.searchTerm) parts.push(`search="${f.searchTerm}"`);
    return `Filters applied: ${parts.join(' · ')}`;
}

export interface WatermarkGapLike {
    accountId: string;
    region: string;
    scope: string;
    gapReason?: string | null;
    gapFromAt?: string | null;
    gapToAt?: string | null;
}

export function buildCoverageStatement(
    gaps: WatermarkGapLike[],
    truncated: boolean,
    seal: { day: string; seal: string; rowCount: number } | null,
    effect: ScalingEffectFilter,
    filters: ExportFilters
): string[] {
    const lines: string[] = [];
    lines.push(describeFilters(filters));
    lines.push(`This report reflects records the platform successfully retrieved from AWS and its own scheduler. Known gaps are listed below and are unrecoverable once AWS's ~6-week activity retention has elapsed.`);
    // State the scope of the row set explicitly. An export that quietly omitted
    // suppressed evaluations would read as "these were the only scaling records",
    // which is exactly the claim this module must not make implicitly.
    if (effect === 'all') {
        lines.push(`Scope: COMPLETE record — every captured row, including policy evaluations where AWS chose not to scale (NotScaledReasons), guardrail-only min/max changes, and attempts that never took effect.`);
    } else {
        lines.push(`Scope: EFFECTIVE CAPACITY CHANGES ONLY — rows where desired or actual capacity genuinely moved. Deliberately EXCLUDED from this file: policy evaluations that AWS suppressed (NotScaledReasons, e.g. AlreadyAtDesiredCapacity/AlreadyAtMinCapacity), guardrail-only min/max bound changes, and attempts that ended Failed/Cancelled/Unfulfilled. Those rows remain in the immutable record — re-export with the "complete record" option to include them.`);
    }
    // CAPTURE and ATTRIBUTION are stated separately, per scope, because they fail
    // differently and the distinction is material to a regulator.
    //
    // The previous wording said only that out-of-band changes "are not attributed
    // to an individual". That presupposes such changes are PRESENT and merely
    // unnamed — which is true for ASG but false for ECS, where a direct
    // ecs:UpdateService never reaches Application Auto Scaling and is therefore
    // absent from the record entirely. Read together with "No known coverage gaps"
    // below, that implied a complete row set. Verified against live AWS behaviour
    // on 2026-08-05.
    lines.push(`Capture and attribution scope, by resource type:`);
    lines.push(`  - ASG (EC2 Auto Scaling): every capacity change is recorded regardless of origin, including changes made directly via the AWS console or CLI. The activity identifies the trigger (e.g. "a user request") but NOT the individual principal who made it.`);
    lines.push(`  - ECS (Application Auto Scaling): only changes initiated BY Application Auto Scaling are recorded — scheduled actions, scaling policies, and its own evaluations. A direct ecs:UpdateService call from the console, CLI, or a deployment pipeline does NOT appear in the source API and is therefore ABSENT from this report.`);
    lines.push(`  - Platform-initiated changes (source=platform): carry the acting user and the originating schedule.`);
    lines.push(`Identifying individual principals, and capturing direct ecs:UpdateService changes, both require CloudTrail integration — not yet implemented.`);
    // The load-bearing sentence: without it, "No known coverage gaps" reads as
    // "nothing was missed". Coverage rows attest poll success, not source
    // completeness.
    lines.push(`Note on the coverage statement below: it reports whether the platform's polls of the source APIs succeeded. It does NOT assert that those APIs expose every path by which capacity can change — see the ECS limitation above.`);
    if (truncated) lines.push(`WARNING: export row cap reached — this file does not contain every matching event. Narrow the filters (date range/account) and re-export for a complete set.`);
    if (gaps.length === 0) {
        lines.push('No known coverage gaps at export time.');
    } else {
        lines.push(`${gaps.length} known coverage gap(s):`);
        for (const g of gaps) {
            lines.push(`  - account=${g.accountId} region=${g.region} scope=${g.scope}: ${g.gapReason ?? 'unspecified'} (from ${istTimestamp(g.gapFromAt)} to ${istTimestamp(g.gapToAt)} IST)`);
        }
    }
    if (seal) {
        lines.push(`Tamper-evidence seal as of ${seal.day}: ${seal.seal} (${seal.rowCount} row(s) sealed that day). See the daily hash-chain in scaling_audit_daily_seals.`);
    } else {
        lines.push('No tamper-evidence seal has been computed yet for this tenant.');
    }
    return lines;
}

const HEADER_FILL = 'FF1F2937'; // slate-800
const HEADER_TEXT = 'FFFFFFFF';
const STRIPE_FILL = 'FFF3F4F6'; // gray-100

export async function buildWorkbook(events: ScalingEvent[], coverageStatement: string[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Nucleus Cloud Ops — Scale Sentinel';
    workbook.created = new Date();

    const notes = workbook.addWorksheet('Coverage Notes');
    notes.getColumn(1).width = 130;
    notes.getColumn(1).alignment = { wrapText: true, vertical: 'top' };
    const title = notes.addRow(['Scale Sentinel Export — SEBI Compliance Record']);
    title.font = { bold: true, size: 13 };
    notes.addRow([`Generated ${istTimestamp(new Date().toISOString())} IST`]);
    notes.addRow([]);
    for (const line of coverageStatement) notes.addRow([line]);

    const sheet = workbook.addWorksheet('Events');
    sheet.columns = EXPORT_COLUMNS.map((c) => ({ header: c.label, key: c.key, width: c.width }));
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: HEADER_TEXT } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
        cell.alignment = { vertical: 'middle' };
    });
    headerRow.height = 20;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const e of events) {
        const row: Record<string, string | number> = {};
        for (const c of EXPORT_COLUMNS) row[c.key] = cellValue(e, c.key);
        sheet.addRow(row);
    }
    if (events.length > 0) {
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXPORT_COLUMNS.length } };
    }
    EXPORT_COLUMNS.forEach((c, idx) => {
        if (NUMERIC_KEYS.has(c.key)) {
            const col = sheet.getColumn(idx + 1);
            col.numFmt = '0.##';
            col.alignment = { horizontal: 'right' };
        }
    });
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1 || rowNumber % 2 === 0) return;
        row.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STRIPE_FILL } };
        });
    });

    const buf = await workbook.xlsx.writeBuffer();
    return Buffer.from(buf);
}

// Curated subset of EXPORT_COLUMNS that actually fits a landscape A4 page at
// readable size — the full 30-column set belongs in the Excel sheet, not
// crammed onto paper.
const PDF_COLUMNS: Array<{ label: string; width: number; get: (e: ScalingEvent) => string }> = [
    { label: 'Date (IST)', width: 30, get: (e) => istTimestamp(e.startedAt) },
    { label: 'Scope/Source', width: 26, get: (e) => `${e.scope}/${e.source}` },
    { label: 'Type', width: 22, get: (e) => e.scalingType },
    { label: 'Account/Region', width: 32, get: (e) => `${e.accountId}/${e.region}` },
    { label: 'Resource', width: 46, get: (e) => e.resourceId },
    { label: 'Capacity', width: 24, get: (e) => `${e.desiredBefore ?? '-'} → ${e.desiredAfter ?? '-'}` },
    { label: 'Status', width: 20, get: (e) => e.statusCode ?? '-' },
    { label: 'Actor', width: 44, get: (e) => e.actor },
];
const PDF_TABLE_WIDTH = PDF_COLUMNS.reduce((s, c) => s + c.width, 0);
const PDF_ROW_H = 6;
const PDF_HEADER_H = 7;
const PDF_MARGIN = 10;
const PDF_PAGE_BOTTOM = 195; // landscape A4 is 210mm tall; leave a footer margin

function truncateToWidth(doc: import('jspdf').jsPDF, text: string, maxWidthMm: number): string {
    if (doc.getTextWidth(text) <= maxWidthMm) return text;
    let t = text;
    while (t.length > 1 && doc.getTextWidth(`${t}…`) > maxWidthMm) t = t.slice(0, -1);
    return `${t}…`;
}

function drawTableHeader(doc: import('jspdf').jsPDF, y: number): number {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setFillColor(31, 41, 55);
    doc.rect(PDF_MARGIN, y, PDF_TABLE_WIDTH, PDF_HEADER_H, 'F');
    doc.setTextColor(255, 255, 255);
    let x = PDF_MARGIN;
    for (const col of PDF_COLUMNS) {
        doc.text(truncateToWidth(doc, col.label, col.width - 3), x + 1.5, y + PDF_HEADER_H - 2);
        x += col.width;
    }
    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    return y + PDF_HEADER_H;
}

export async function buildPdf(events: ScalingEvent[], coverageStatement: string[]): Promise<Buffer> {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
    let y = PDF_MARGIN;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Scale Sentinel Export — SEBI Compliance Record', PDF_MARGIN, y);
    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    for (const line of coverageStatement) {
        const wrapped: string[] = doc.splitTextToSize(line, 277);
        for (const w of wrapped) {
            doc.text(w, PDF_MARGIN, y);
            y += 4;
        }
    }
    y += 4;

    if (events.length === 0) {
        doc.setFont('helvetica', 'italic');
        doc.text('No events match the applied filters.', PDF_MARGIN, y);
    } else {
        y = drawTableHeader(doc, y);
        events.forEach((e, i) => {
            if (y + PDF_ROW_H > PDF_PAGE_BOTTOM) {
                doc.addPage();
                y = drawTableHeader(doc, PDF_MARGIN);
            }
            if (i % 2 === 1) {
                doc.setFillColor(243, 244, 246);
                doc.rect(PDF_MARGIN, y, PDF_TABLE_WIDTH, PDF_ROW_H, 'F');
            }
            let x = PDF_MARGIN;
            for (const col of PDF_COLUMNS) {
                doc.text(truncateToWidth(doc, col.get(e), col.width - 3), x + 1.5, y + PDF_ROW_H - 2);
                x += col.width;
            }
            doc.setDrawColor(209, 213, 219);
            x = PDF_MARGIN;
            for (const col of PDF_COLUMNS) {
                doc.line(x, y, x, y + PDF_ROW_H);
                x += col.width;
            }
            doc.line(x, y, x, y + PDF_ROW_H);
            doc.line(PDF_MARGIN, y + PDF_ROW_H, PDF_MARGIN + PDF_TABLE_WIDTH, y + PDF_ROW_H);
            y += PDF_ROW_H;
        });
    }

    return Buffer.from(doc.output('arraybuffer') as ArrayBuffer);
}

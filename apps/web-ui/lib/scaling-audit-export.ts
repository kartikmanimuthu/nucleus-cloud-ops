import { formatInTimeZone } from 'date-fns-tz';
import ExcelJS from 'exceljs';
import type { ScalingEffectFilter, ScalingEvent, ScalingScope, ScalingSource, ScalingType } from '@/lib/db/repositories/scaling-audit/interface';
import type { NetworkAvailabilityReportRow } from '@/lib/db/repositories/network-links/interface';

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
    /** 'network' is not a ScalingScope — it selects the Direct Connect & VPN
     *  availability report, a different report shape entirely (fixed
     *  availability/bandwidth rows, not a scaling-event list). See the
     *  branch in app/api/scaling-audit/export/route.ts. */
    scope?: ScalingScope | 'network';
    source?: ScalingSource;
    scalingType?: ScalingType;
    resourceId?: string;
    searchTerm?: string;
    effect?: ScalingEffectFilter;
    dateFrom?: string;
    dateTo?: string;
}

/** 'ecs' -> "Scale Sentinel Export (ECS) — SEBI Compliance Record", etc.
 *  Puts the exported scope in the title itself so opening the file is enough
 *  to confirm it's the right one — the previous hardcoded title made every
 *  scope's file look identical at a glance. */
export function exportTitle(scope?: string): string {
    const what = scope === 'network' ? 'Direct Connect & VPN' : scope ? scope.toUpperCase() : 'All resource types';
    return `Scale Sentinel Export (${what}) — SEBI Compliance Record`;
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

// One bullet per scaling scope, stating what the source API captures and who
// (if anyone) it attributes the change to. Selected per export by
// buildCoverageStatement below — a single-scope export must not carry
// bullets for scopes it doesn't contain, or the file misdescribes its own
// rows. Text is transcribed from the workers' own capture-mechanism comments
// (apps/workers/src/jobs/scaling-audit/services/*.ts), not invented.
const SCOPE_CAPTURE_NOTES: Record<ScalingScope, string> = {
    asg: 'ASG (EC2 Auto Scaling): every capacity change is recorded regardless of origin, including changes made directly via the AWS console or CLI. The activity identifies the trigger (e.g. "a user request") but NOT the individual principal who made it.',
    ecs: 'ECS (Application Auto Scaling): only changes initiated BY Application Auto Scaling are recorded — scheduled actions, scaling policies, and its own evaluations. A direct ecs:UpdateService call from the console, CLI, or a deployment pipeline does NOT appear in the source API and is therefore ABSENT from this report.',
    rds: 'RDS: AWS-initiated storage-autoscaling completions are captured from rds:DescribeEvents (RDS-EVENT-0218) and carry no caller — RDS performs them internally. Instance-class changes, manual storage changes, and read-replica add/remove are captured from CloudTrail with the calling principal.',
    msk: 'MSK: broker count, storage, and instance-type changes are captured from ListClusterOperationsV2. MSK has no passive scaling-policy mechanism — every capacity change is an explicit API call; CloudTrail supplies the calling principal.',
    elasticache: 'ElastiCache: CloudTrail is the sole source — ElastiCache exposes no scaling-activity API. Capture is limited to CloudTrail event history (~90 days) for the Modify/IncreaseReplicaCount/DecreaseReplicaCount calls that change capacity.',
    docdb: 'DocumentDB: instance-class changes and read-replica add/remove are captured from docdb:DescribeEvents, which AWS serves only for the past 14 days; CloudTrail supplies the calling principal.',
};

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
    // A single-scope export shows only its own bullet; an export spanning
    // every scope (no scope filter applied) shows all of them, in the same
    // fixed order every time — Object.keys on a const Record is stable.
    const scopeNotes: ScalingScope[] =
        filters.scope && filters.scope !== 'network' ? [filters.scope] : (Object.keys(SCOPE_CAPTURE_NOTES) as ScalingScope[]);
    for (const s of scopeNotes) lines.push(`  - ${SCOPE_CAPTURE_NOTES[s]}`);
    lines.push(`  - Platform-initiated changes (source=platform): carry the acting user and the originating schedule.`);
    // CloudTrail's out-of-band watch list (services/cloudtrail-client.ts) only
    // covers these three API calls, split by scope — an RDS/MSK/ElastiCache/
    // DocDB-only export names none of them (it already states its own
    // CloudTrail role in its SCOPE_CAPTURE_NOTES bullet above), and an
    // ASG-only export must not mention ecs:UpdateService, or vice versa.
    const WATCHED_CLOUDTRAIL_EVENTS: Partial<Record<ScalingScope, string[]>> = {
        ecs: ['ecs:UpdateService'],
        asg: ['asg:SetDesiredCapacity', 'asg:UpdateAutoScalingGroup'],
    };
    const relevantEvents = scopeNotes.flatMap((s) => WATCHED_CLOUDTRAIL_EVENTS[s] ?? []);
    if (relevantEvents.length > 0) {
        lines.push(`Direct ${relevantEvents.join(', ')} call(s) are captured via CloudTrail (event history ~90 days), which identifies the calling principal. Changes older than that window cannot be attributed retrospectively.`);
    }
    // The load-bearing sentence: without it, "No known coverage gaps" reads as
    // "nothing was missed". Coverage rows attest poll success, not source
    // completeness.
    lines.push(`Note on the coverage statement below: it reports whether the platform's polls of the source APIs succeeded. It does NOT assert that those APIs expose every path by which capacity can change — see the per-scope capture notes above.`);
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

/**
 * Coverage statement for the Direct Connect & VPN availability report — a
 * different report shape from buildCoverageStatement above (fixed
 * availability/bandwidth rows, not a scaling-event list), so it earns its
 * own function rather than a branch bolted onto the event-list one. Every
 * line is mechanically verifiable against lib/network-availability-report.ts
 * and workers/.../network-cloudwatch-client.ts — no regulatory claims beyond
 * what those already implement.
 */
export function buildNetworkCoverageStatement(filters: ExportFilters, rowCount: number): string[] {
    const lines: string[] = [];
    lines.push(describeFilters(filters));
    lines.push('Aggregated from hourly CloudWatch samples collected by the platform\'s Direct Connect/VPN poller, for the window above.');
    lines.push('Availability = fraction of hours in the window in which the link reported up for the whole hour. Hours with no sample count as not-up — a monitoring gap is never counted as uptime.');
    lines.push('"DX + VPN backup combined" counts an hour as up if ANY monitored path (the DX connection or any VPN backup tunnel) was up that hour.');
    lines.push('Direct Connect bandwidth figures are true per-hour averages and maxima. VPN tunnel throughput is derived from CloudWatch\'s hourly cumulative byte totals, so a VPN row\'s peak equals its hourly average — a finer intra-hour peak is not available at this resolution.');
    lines.push('Installed capacity: Direct Connect uses the connection\'s provisioned bandwidth; VPN tunnels use AWS\'s fixed 1.25 Gbps per-tunnel ceiling.');
    lines.push('"No. of instances >70%" counts distinct hourly buckets where either direction\'s traffic exceeded 70% of installed capacity — N/A for the two availability rows, which have no single bandwidth figure to breach.');
    if (rowCount === 0) {
        lines.push('No network link samples were recorded in this window — this file contains no data rows.');
    }
    lines.push('The scaling-audit daily tamper-evidence seal (scaling_audit_daily_seals) covers scaling-event rows and does not apply to this report.');
    return lines;
}

const HEADER_FILL = 'FF1F2937'; // slate-800
const HEADER_TEXT = 'FFFFFFFF';
const STRIPE_FILL = 'FFF3F4F6'; // gray-100

/** Shared by every renderer below — the "Coverage Notes" sheet is identical
 *  in shape whether the workbook goes on to hold an event list or the
 *  network availability table. */
function addCoverageNotesSheet(workbook: ExcelJS.Workbook, title: string, coverageStatement: string[]): void {
    const notes = workbook.addWorksheet('Coverage Notes');
    notes.getColumn(1).width = 130;
    notes.getColumn(1).alignment = { wrapText: true, vertical: 'top' };
    const titleRow = notes.addRow([title]);
    titleRow.font = { bold: true, size: 13 };
    notes.addRow([`Generated ${istTimestamp(new Date().toISOString())} IST`]);
    notes.addRow([]);
    for (const line of coverageStatement) notes.addRow([line]);
}

export async function buildWorkbook(events: ScalingEvent[], coverageStatement: string[], title: string): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Nucleus Cloud Ops — Scale Sentinel';
    workbook.created = new Date();

    addCoverageNotesSheet(workbook, title, coverageStatement);

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

// Matches the on-screen table's headers exactly
// (components/scaling-audit/network-availability-report.tsx) — 3-6 fixed
// rows, not a per-event list, so no autoFilter and no numeric-column
// formatting (breachCount is rendered as 'N/A' or a plain integer).
const NETWORK_COLUMNS: Array<{ key: keyof NetworkAvailabilityReportRow; label: string; width: number }> = [
    { key: 'particulars', label: 'Particulars', width: 46 },
    { key: 'installedCapacity', label: 'Installed Capacity', width: 22 },
    { key: 'utilisedCapacity', label: 'Utilised capacity', width: 60 },
    { key: 'peakLoad', label: 'Highest Peak load during period', width: 56 },
    { key: 'breachCount', label: 'No. of instances >70%', width: 18 },
];

function networkCellValue(row: NetworkAvailabilityReportRow, key: keyof NetworkAvailabilityReportRow): string | number {
    if (key === 'breachCount') return row.breachCount === null ? 'N/A' : row.breachCount;
    return row[key] as string;
}

export async function buildNetworkWorkbook(rows: NetworkAvailabilityReportRow[], coverageStatement: string[], title: string): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Nucleus Cloud Ops — Scale Sentinel';
    workbook.created = new Date();

    addCoverageNotesSheet(workbook, title, coverageStatement);

    const sheet = workbook.addWorksheet('Network Availability');
    sheet.columns = NETWORK_COLUMNS.map((c) => ({ header: c.label, key: c.key, width: c.width }));
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: HEADER_TEXT } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
        cell.alignment = { vertical: 'middle' };
    });
    headerRow.height = 20;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const r of rows) {
        const row: Record<string, string | number> = {};
        for (const c of NETWORK_COLUMNS) row[c.key] = networkCellValue(r, c.key);
        sheet.addRow(row);
    }
    NETWORK_COLUMNS.forEach((c, idx) => {
        if (c.key === 'utilisedCapacity' || c.key === 'peakLoad') {
            sheet.getColumn(idx + 1).alignment = { wrapText: true, vertical: 'top' };
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

function drawTableHeader(doc: import('jspdf').jsPDF, y: number, columns: Array<{ label: string; width: number }>): number {
    const tableWidth = columns.reduce((s, c) => s + c.width, 0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setFillColor(31, 41, 55);
    doc.rect(PDF_MARGIN, y, tableWidth, PDF_HEADER_H, 'F');
    doc.setTextColor(255, 255, 255);
    let x = PDF_MARGIN;
    for (const col of columns) {
        doc.text(truncateToWidth(doc, col.label, col.width - 3), x + 1.5, y + PDF_HEADER_H - 2);
        x += col.width;
    }
    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    return y + PDF_HEADER_H;
}

/** Shared preamble every PDF renderer draws: title, then the wrapped
 *  coverage-statement lines. Returns the y position to start the table at. */
function drawPdfPreamble(doc: import('jspdf').jsPDF, title: string, coverageStatement: string[]): number {
    let y = PDF_MARGIN;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text(title, PDF_MARGIN, y);
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
    return y + 4;
}

export async function buildPdf(events: ScalingEvent[], coverageStatement: string[], title: string): Promise<Buffer> {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
    let y = drawPdfPreamble(doc, title, coverageStatement);

    if (events.length === 0) {
        doc.setFont('helvetica', 'italic');
        doc.text('No events match the applied filters.', PDF_MARGIN, y);
    } else {
        y = drawTableHeader(doc, y, PDF_COLUMNS);
        events.forEach((e, i) => {
            if (y + PDF_ROW_H > PDF_PAGE_BOTTOM) {
                doc.addPage();
                y = drawTableHeader(doc, PDF_MARGIN, PDF_COLUMNS);
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

// Sums to 277mm — landscape A4 (297mm) minus 2×PDF_MARGIN. Wider than
// PDF_COLUMNS' per-column budget because a bandwidth report has only 5
// columns to spread across the same page, not 8.
const NETWORK_PDF_COLUMNS: Array<{ label: string; width: number; get: (r: NetworkAvailabilityReportRow) => string }> = [
    { label: 'Particulars', width: 62, get: (r) => r.particulars },
    { label: 'Installed Capacity', width: 30, get: (r) => r.installedCapacity },
    { label: 'Utilised capacity', width: 85, get: (r) => r.utilisedCapacity },
    { label: 'Highest Peak load during period', width: 75, get: (r) => r.peakLoad },
    { label: 'No. of instances >70%', width: 25, get: (r) => (r.breachCount === null ? 'N/A' : String(r.breachCount)) },
];
const NETWORK_PDF_TABLE_WIDTH = NETWORK_PDF_COLUMNS.reduce((s, c) => s + c.width, 0);
const NETWORK_PDF_LINE_H = 4;

/**
 * Only 3-6 rows, so unlike buildPdf's event table this wraps each cell
 * instead of truncating — a bandwidth/percentage figure cut short by
 * truncateToWidth is not an acceptable corner to cut in a compliance file
 * (see buildNetworkPdf's own test for the specific value this would have
 * clipped).
 */
export async function buildNetworkPdf(rows: NetworkAvailabilityReportRow[], coverageStatement: string[], title: string): Promise<Buffer> {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
    let y = drawPdfPreamble(doc, title, coverageStatement);

    if (rows.length === 0) {
        doc.setFont('helvetica', 'italic');
        doc.text('No network link samples match the applied filters.', PDF_MARGIN, y);
    } else {
        y = drawTableHeader(doc, y, NETWORK_PDF_COLUMNS);
        rows.forEach((r, i) => {
            const cellLines = NETWORK_PDF_COLUMNS.map((col) => doc.splitTextToSize(col.get(r), col.width - 3) as string[]);
            const rowH = Math.max(...cellLines.map((lines) => lines.length)) * NETWORK_PDF_LINE_H + 2;

            if (y + rowH > PDF_PAGE_BOTTOM) {
                doc.addPage();
                y = drawTableHeader(doc, PDF_MARGIN, NETWORK_PDF_COLUMNS);
            }
            if (i % 2 === 1) {
                doc.setFillColor(243, 244, 246);
                doc.rect(PDF_MARGIN, y, NETWORK_PDF_TABLE_WIDTH, rowH, 'F');
            }
            let x = PDF_MARGIN;
            cellLines.forEach((lines, colIdx) => {
                lines.forEach((line, lineIdx) => {
                    doc.text(line, x + 1.5, y + NETWORK_PDF_LINE_H * (lineIdx + 1));
                });
                x += NETWORK_PDF_COLUMNS[colIdx].width;
            });
            doc.setDrawColor(209, 213, 219);
            x = PDF_MARGIN;
            for (const col of NETWORK_PDF_COLUMNS) {
                doc.line(x, y, x, y + rowH);
                x += col.width;
            }
            doc.line(x, y, x, y + rowH);
            doc.line(PDF_MARGIN, y + rowH, PDF_MARGIN + NETWORK_PDF_TABLE_WIDTH, y + rowH);
            y += rowH;
        });
    }

    return Buffer.from(doc.output('arraybuffer') as ArrayBuffer);
}

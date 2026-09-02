import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { ScalingAuditService } from '@/lib/scaling-audit-service';
import { NetworkLinksService } from '@/lib/network-links-service';
import { buildNetworkAvailabilityReport } from '@/lib/network-availability-report';
import { istDayStart, istDayEndExclusive } from '@/lib/ist-date-range';
import {
    buildCoverageStatement,
    buildNetworkCoverageStatement,
    buildNetworkPdf,
    buildNetworkWorkbook,
    buildPdf,
    buildWorkbook,
    exportTitle,
    type ExportFilters,
} from '@/lib/scaling-audit-export';
import type { ScalingEffectFilter, ScalingScope, ScalingSource, ScalingType } from '@/lib/db/repositories/scaling-audit/interface';

interface ExportBody extends ExportFilters {
    format?: 'xlsx' | 'pdf';
    scope?: ScalingScope | 'network';
    source?: ScalingSource;
    scalingType?: ScalingType;
}

// The Direct Connect & VPN report is a different report SHAPE, not another
// scope of the event list: 3-6 fixed availability/bandwidth rows over a
// defined window, sourced from network_link_samples rather than
// scaling_audit_events. Mirrors GET /api/network-links/report, which the
// on-screen report already uses.
async function exportNetworkReport(body: ExportBody, format: 'xlsx' | 'pdf', tenantId: string, userId: string): Promise<NextResponse> {
    const { dateFrom, dateTo } = body;
    if (!dateFrom || !dateTo) {
        return NextResponse.json(
            { success: false, error: 'dateFrom and dateTo are required for a network export' },
            { status: 400 }
        );
    }

    const samples = await NetworkLinksService.listSamples(tenantId, {
        accountId: body.accountId,
        region: body.region,
        dateFrom,
        dateTo,
    });
    const rows = buildNetworkAvailabilityReport(samples, istDayStart(dateFrom), istDayEndExclusive(dateTo));

    const filters = { scope: 'network' as const, accountId: body.accountId, region: body.region, dateFrom, dateTo };
    const coverageStatement = buildNetworkCoverageStatement(filters, rows.length);
    const title = exportTitle('network');

    const payload = (format === 'xlsx'
        ? await buildNetworkWorkbook(rows, coverageStatement, title)
        : await buildNetworkPdf(rows, coverageStatement, title)) as BodyInit;
    const contentType = format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf';

    await ScalingAuditService.logExport(tenantId, userId, format, filters, rows.length, null);

    return new NextResponse(payload, {
        status: 200,
        headers: {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="network-availability-${dateFrom}_to_${dateTo}.${format}"`,
        },
    });
}

// POST /api/scaling-audit/export — on-demand Excel/PDF export for SEBI submission.
// Every export is itself audit-logged (who, when, filters, row count, seal) —
// the existing inventory export route omits this, which this module must not.
// The actual xlsx/pdf rendering lives in lib/scaling-audit-export.ts, unit-tested
// there — this route stays thin: parse body, fetch data, render, respond.
export async function POST(request: NextRequest) {
    const authError = await authorize('read', 'ScalingAudit');
    if (authError) return authError;

    try {
        const body = (await request.json().catch(() => ({}))) as ExportBody;
        const format = body.format === 'pdf' ? 'pdf' : 'xlsx';
        const tenantId = await getSessionTenantId();
        const userId = await getSessionUserId();

        // Captured into a const so TS narrows ScalingScope | undefined below,
        // independent of property-narrowing subtleties across the awaits above.
        const scope = body.scope;
        if (scope === 'network') return await exportNetworkReport(body, format, tenantId, userId);

        const effect: ScalingEffectFilter = body.effect === 'all' ? 'all' : 'capacity_changes';
        const filters = {
            tenantId,
            accountId: body.accountId,
            region: body.region,
            scope,
            source: body.source,
            scalingType: body.scalingType,
            resourceId: body.resourceId,
            searchTerm: body.searchTerm,
            effect,
            dateFrom: body.dateFrom,
            dateTo: body.dateTo,
        };

        const { events, gaps, seal, truncated } = await ScalingAuditService.getExportData(filters);
        const coverageStatement = buildCoverageStatement(gaps, truncated, seal, effect, body);
        const title = exportTitle(scope);

        const dateStamp = new Date().toISOString().slice(0, 10);
        // Buffer structurally satisfies BodyInit at runtime (it's a Uint8Array)
        // — the cast sidesteps a Buffer<ArrayBufferLike>-vs-BodyInit variance
        // quirk between @types/node and the DOM lib, not an actual mismatch.
        const payload = (format === 'xlsx'
            ? await buildWorkbook(events, coverageStatement, title)
            : await buildPdf(events, coverageStatement, title)) as BodyInit;
        const contentType = format === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/pdf';
        const filename = `scaling-audit-${scope ?? 'all-scopes'}-${dateStamp}.${format}`;

        await ScalingAuditService.logExport(tenantId, userId, format, filters, events.length, seal?.seal ?? null);

        return new NextResponse(payload, {
            status: 200,
            headers: {
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${filename}"`,
            },
        });
    } catch (error: unknown) {
        console.error('API - Error exporting scaling audit records:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to export scaling audit records' },
            { status: 500 }
        );
    }
}

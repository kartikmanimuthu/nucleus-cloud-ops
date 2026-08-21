import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { ScalingAuditService } from '@/lib/scaling-audit-service';
import { buildCoverageStatement, buildPdf, buildWorkbook, type ExportFilters } from '@/lib/scaling-audit-export';
import type { ScalingEffectFilter, ScalingScope, ScalingSource, ScalingType } from '@/lib/db/repositories/scaling-audit/interface';

interface ExportBody extends ExportFilters {
    format?: 'xlsx' | 'pdf';
    scope?: ScalingScope;
    source?: ScalingSource;
    scalingType?: ScalingType;
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

        const effect: ScalingEffectFilter = body.effect === 'all' ? 'all' : 'capacity_changes';
        const filters = {
            tenantId,
            accountId: body.accountId,
            region: body.region,
            scope: body.scope,
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

        const dateStamp = new Date().toISOString().slice(0, 10);
        // Buffer structurally satisfies BodyInit at runtime (it's a Uint8Array)
        // — the cast sidesteps a Buffer<ArrayBufferLike>-vs-BodyInit variance
        // quirk between @types/node and the DOM lib, not an actual mismatch.
        const payload = (format === 'xlsx'
            ? await buildWorkbook(events, coverageStatement)
            : await buildPdf(events, coverageStatement)) as BodyInit;
        const contentType = format === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/pdf';
        const filename = `scaling-audit-export-${dateStamp}.${format}`;

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

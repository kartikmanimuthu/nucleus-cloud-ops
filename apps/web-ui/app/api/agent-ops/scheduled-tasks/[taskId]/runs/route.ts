/**
 * GET /api/agent-ops/scheduled-tasks/[taskId]/runs
 *
 * Paginated run history for one scheduled task. The taskId filter is pushed into
 * the query (trigger->>'taskId') rather than applied in JS over a tenant-wide
 * page of runs — the latter silently drops this task's older runs as soon as
 * other tasks' runs fill the fetch window, and makes `total` meaningless.
 */
import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { getSessionTenantId } from '@/lib/auth-session';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'ScheduledTask' },
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function GET(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
    try {
        const { taskId } = await params;
        const tenantId = await getSessionTenantId();
        const url = new URL(req.url);

        const parsedPage = parseInt(url.searchParams.get('page') || '1', 10);
        const parsedLimit = parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10);
        const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
        const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(parsedLimit, MAX_LIMIT)
            : DEFAULT_LIMIT;

        const { runs, total } = await agentOpsService.listRuns({
            tenantId,
            source: 'scheduled',
            taskId,
            page,
            limit,
        });

        return NextResponse.json({ runs, total, page, limit });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}

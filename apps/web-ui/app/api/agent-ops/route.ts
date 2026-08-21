/**
 * Agent Ops — List Runs API
 *
 * GET /api/agent-ops
 * Query params: source, status, limit
 */

import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { getReadRowFilter } from '@/lib/rbac/row-filter';
import type { TriggerSource, AgentOpsStatus, RunListQuery } from '@/lib/agent-ops/types';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'AgentOps' },
};

const VALID_SORT_FIELDS: RunListQuery['sortBy'][] = ['createdAt', 'updatedAt', 'status', 'source', 'taskDescription', 'durationMs'];

export async function GET(req: Request) {
    try {
        const tenantId = await getSessionTenantId();
        const url = new URL(req.url);
        const source = url.searchParams.get('source') as TriggerSource | null;
        const status = url.searchParams.get('status') as AgentOpsStatus | null;
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
        const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '25', 10)));
        const sortByParam = url.searchParams.get('sortBy') as RunListQuery['sortBy'] | null;
        const sortBy = sortByParam && VALID_SORT_FIELDS.includes(sortByParam) ? sortByParam : 'createdAt';
        const sortDir = url.searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc';

        const { runs, total, stats } = await agentOpsService.listRuns({
            tenantId,
            source: source || undefined,
            status: status || undefined,
            page,
            limit,
            sortBy,
            sortDir,
            // Gate 3. authz above (Layer 1) settled WHETHER this caller may list
            // runs; this settles WHICH ones, in SQL, so page counts stay honest.
            rowFilter: await getReadRowFilter('Agent'),
        });

        return NextResponse.json({
            success: true,
            data: runs,
            total,
            stats,
        });

    } catch (error) {
        console.error('[Agent Ops API] List runs error:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Internal server error',
        }, { status: 500 });
    }
}

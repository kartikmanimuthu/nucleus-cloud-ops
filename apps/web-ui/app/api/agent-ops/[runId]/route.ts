/**
 * Agent Ops — Run Detail API
 *
 * GET /api/agent-ops/[runId]
 */

import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { getSessionTenantId } from '@/lib/auth-session';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'AgentOps' },
};

export async function GET(
    req: Request,
    { params }: { params: Promise<{ runId: string }> }
) {
    try {
        const { runId } = await params;
        const tenantId = await getSessionTenantId();

        // Fetch run and events in parallel
        const [run, events] = await Promise.all([
            agentOpsService.getRun(tenantId, runId),
            agentOpsService.getRunEvents(runId, tenantId),
        ]);

        if (!run) {
            return NextResponse.json({ error: 'Run not found' }, { status: 404 });
        }

        return NextResponse.json({
            run,
            events,
        });

    } catch (error) {
        console.error('[Agent Ops API] Run detail error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Internal server error',
        }, { status: 500 });
    }
}

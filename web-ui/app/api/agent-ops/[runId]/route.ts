/**
 * Agent Ops — Run Detail API
 * 
 * GET /api/agent-ops/[runId]
 * Query params: tenantId
 */

import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';

export async function GET(
    req: Request,
    { params }: { params: Promise<{ runId: string }> }
) {
    try {
        const { runId } = await params;
        const url = new URL(req.url);
        const tenantId = url.searchParams.get('tenantId') || 'default';

        // Fetch run and events in parallel
        const [run, events] = await Promise.all([
            agentOpsService.getRun(tenantId, runId),
            agentOpsService.getRunEvents(runId),
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

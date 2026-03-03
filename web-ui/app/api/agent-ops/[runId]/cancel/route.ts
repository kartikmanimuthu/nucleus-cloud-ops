/**
 * Agent Ops — Cancel Run
 *
 * POST /api/agent-ops/[runId]/cancel
 * Body: { tenantId: string }
 *
 * Signals the in-flight run to stop at the next event loop iteration.
 * If the run is not currently in-flight (already completed/failed), it
 * still marks the status as 'cancelled' in DynamoDB.
 */

import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { cancelRun } from '@/lib/agent-ops/run-manager';

export async function POST(
    req: Request,
    { params }: { params: Promise<{ runId: string }> }
) {
    try {
        const { runId } = await params;
        const body = await req.json() as { tenantId?: string };
        const tenantId = body.tenantId || 'default';

        const run = await agentOpsService.getRun(tenantId, runId);
        if (!run) {
            return NextResponse.json({ error: 'Run not found' }, { status: 404 });
        }

        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
            return NextResponse.json(
                { error: `Run is already in terminal state: ${run.status}` },
                { status: 409 }
            );
        }

        // Signal the in-flight executor to stop (no-op if run already finished)
        const wasActive = cancelRun(runId);

        // Always update DynamoDB status — executor may have already exited
        await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
        await agentOpsService.recordEvent({
            runId,
            eventType: 'final',
            node: '__cancelled__',
            content: 'Run cancelled by user.',
            metadata: { wasActive },
        });

        return NextResponse.json({ runId, status: 'cancelled', wasActive });

    } catch (error) {
        console.error('[CancelEndpoint] Error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Internal server error' },
            { status: 500 }
        );
    }
}

/**
 * Agent Ops — Resume Endpoint
 *
 * POST /api/agent-ops/[runId]/resume
 *
 * Resumes a run that is currently in 'awaiting_input' status by re-triggering
 * execution with the original task enriched by the user's clarification reply.
 *
 * Body: { userInput: string, tenantId: string }
 */

import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';

export async function POST(
    req: Request,
    { params }: { params: Promise<{ runId: string }> }
) {
    try {
        const { runId } = await params;
        const body = await req.json() as { userInput?: string; tenantId?: string };
        const { userInput, tenantId = 'default' } = body;

        if (!userInput?.trim()) {
            return NextResponse.json({ error: 'userInput is required' }, { status: 400 });
        }

        // Fetch the existing run
        const run = await agentOpsService.getRun(tenantId, runId);
        if (!run) {
            return NextResponse.json({ error: 'Run not found' }, { status: 404 });
        }

        if (run.status !== 'awaiting_input') {
            return NextResponse.json(
                { error: `Run is not awaiting input (current status: ${run.status})` },
                { status: 409 }
            );
        }

        // Build enriched task: original task + clarification thread
        const clarificationContext = run.clarification
            ? `\n\n---\nOriginal clarification question: ${run.clarification.question}\nUser reply: ${userInput.trim()}`
            : `\n\n---\nUser clarification: ${userInput.trim()}`;

        const enrichedTask = run.taskDescription + clarificationContext;

        // Mark run as in_progress again before re-triggering
        await agentOpsService.updateRunStatus(tenantId, runId, 'in_progress');

        // Re-execute with the enriched task description (new threadId = same LangGraph state reset)
        const resumedRun = {
            ...run,
            taskDescription: enrichedTask,
        };

        // Fire-and-forget re-execution
        executeAgentRun(resumedRun).catch((err) => {
            console.error(`[ResumeEndpoint] Execution error for run ${runId}:`, err);
        });

        return NextResponse.json({
            runId,
            status: 'in_progress',
            message: 'Run resumed with clarification context.',
        });

    } catch (error) {
        console.error('[ResumeEndpoint] Error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Internal server error' },
            { status: 500 }
        );
    }
}

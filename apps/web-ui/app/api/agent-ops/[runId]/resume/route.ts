/**
 * Agent Ops — Resume Endpoint
 *
 * POST /api/agent-ops/[runId]/resume
 *
 * Resumes a run that is currently in 'awaiting_input' status by re-triggering
 * execution with the original task enriched by the user's clarification reply.
 *
 * Body: { userInput: string }
 */

import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';
import { getSessionTenantId } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { finalizeScheduledRun } from '@/lib/agent-ops/scheduled-notifier';

export async function POST(
    req: Request,
    { params }: { params: Promise<{ runId: string }> }
) {
    try {
        const { runId } = await params;
        const tenantId = await getSessionTenantId();
        const body = await req.json() as { userInput?: string };
        const { userInput } = body;

        if (!userInput?.trim()) {
            return NextResponse.json({ error: 'userInput is required' }, { status: 400 });
        }

        // Pre-flight ownership check (D-06)
        const run = await agentOpsService.getRun(tenantId, runId);
        if (!run) {
            return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
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

        // Re-execute with the enriched task description on the SAME thread — the
        // checkpoint state (including the stale mode='end' evaluation) survives.
        // evaluatorNode's isReusableEvaluation() guard handles this: a stale
        // clarification evaluation is discarded and the enriched task (with the
        // user's reply) is re-evaluated, so the run can't loop on the old question.
        const resumedRun = {
            ...run,
            taskDescription: enrichedTask,
        };

        // Fire-and-forget re-execution
        executeAgentRun(resumedRun)
            .then(async () => {
                // Scheduled runs: deliver the final digest to the task's channel.
                // countRun: false — the trigger route already counted this run at first settle.
                const freshRun = await agentOpsService.getRun(tenantId, runId);
                if (freshRun) await finalizeScheduledRun(freshRun, { countRun: false });
            })
            .catch((err) => {
                console.error(`[ResumeEndpoint] Execution error for run ${runId}:`, err);
            });

        AuditService.logUserAction({
            eventType: 'agent.run.resumed',
            severity: 'medium',
            apiRoute: 'POST /api/agent-ops/[runId]/resume',
            httpMethod: 'POST',
            action: 'Resumed Agent Run',
            resourceType: 'agent',
            resourceId: runId,
            resourceName: run.taskDescription?.slice(0, 80) || runId,
            user: 'system',
            userType: 'user',
            status: 'success',
            details: `Resumed agent run ${runId} with clarification input`,
            metadata: { tenantId },
        }).catch(() => {});

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

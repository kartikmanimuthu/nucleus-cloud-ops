/**
 * Agent Ops — Deep Per-Action Decisions
 *
 * POST /api/agent-ops/[runId]/decisions
 * Body: { decisions: Array<{ toolCallId, approved, reason?, answer? }> }
 *
 * Deep interrupts are per-action and several can be pending at once (one per
 * parallel sub-agent), so a binary approve/reject on the run cannot express them.
 * This route maps the client's decisions onto the interrupt ids recorded on the
 * run's approvalRequest and resumes with a two-level ResumeMap.
 *
 * The batch path for channel adapters (Slack et al.) lives in ../approve/route.ts,
 * which fans one action out across every pending action.
 */
import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { resumeDeepRun } from '@/lib/agent-ops/deep-run-executor';
import { resolveDeepPendingActions } from '@/lib/agent-ops/deep-batch-decision';
import { toResumeMap, syntheticOutput } from '@/lib/agent/deep/hitl';
import { getGatewayEventBus } from '@/lib/gateway/event-bus';
import { getGatewayService } from '@/lib/gateway';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    POST: { action: 'approve', subject: 'AgentOps' },
};

interface ToolDecisionInput {
    toolCallId: string;
    approved: boolean;
    reason?: string;
    answer?: string;
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ runId: string }> },
) {
    try {
        const { runId } = await params;
        const tenantId = await getSessionTenantId();
        const body = await req.json().catch(() => null) as { decisions?: unknown } | null;

        if (!body || !Array.isArray(body.decisions)) {
            return NextResponse.json({ success: false, error: 'decisions must be an array' }, { status: 400 });
        }
        const decisions = body.decisions as ToolDecisionInput[];

        // Ownership: getRun is tenant-scoped, so a miss is a cross-tenant probe.
        const run = await agentOpsService.getRun(tenantId, runId);
        if (!run) {
            return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
        }
        if (run.mode !== 'deep') {
            return NextResponse.json({
                success: false,
                error: `Run is ${run.mode} mode — use POST /api/agent-ops/${runId}/approve instead.`,
            }, { status: 409 });
        }
        if (run.status !== 'awaiting_approval') {
            return NextResponse.json({
                success: false,
                error: `Run is not awaiting approval (current status: ${run.status})`,
            }, { status: 409 });
        }

        const pendingResult = resolveDeepPendingActions(run);
        if (!pendingResult.ok) {
            return NextResponse.json({
                success: false, error: pendingResult.error,
            }, { status: 409 });
        }
        const pending = pendingResult.actions;

        const mapped = toResumeMap(pending, decisions as never);
        if (!mapped.ok) {
            return NextResponse.json({ success: false, error: mapped.error }, { status: 400 });
        }

        // Rejected and answered actions never execute, so mirror their outcome into
        // the event log — otherwise the timeline shows a tool card that never settles.
        const byId = new Map(decisions.map(d => [d.toolCallId, d]));
        for (const action of pending) {
            const decision = byId.get(action.toolCallId);
            if (!decision || (decision.approved && action.toolName !== 'ask_user')) continue;
            await agentOpsService.recordEvent({
                runId, tenantId, eventType: 'tool_result', node: 'tools',
                toolName: action.toolName,
                toolOutput: syntheticOutput(action, decision as never),
                metadata: { toolCallId: action.toolCallId, synthetic: true, status: 'finished' },
            });
        }

        const eventBus = getGatewayEventBus();
        getGatewayService();

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.run.decisions',
            severity: 'high',
            apiRoute: 'POST /api/agent-ops/[runId]/decisions',
            httpMethod: 'POST',
            action: 'Submitted Deep Agent Action Decisions',
            resourceType: 'AgentOps',
            resourceId: runId,
            resourceName: runId,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Decided ${decisions.length} action(s) on deep run ${runId}`,
            metadata: {
                tenantId,
                approved: decisions.filter(d => d.approved).map(d => d.toolCallId),
                rejected: decisions.filter(d => !d.approved).map(d => d.toolCallId),
            },
        }).catch(() => {});

        // Fire-and-forget: the executor emits run:completed / run:failed to the bus.
        resumeDeepRun(run, mapped.resume, eventBus).catch(err => {
            console.error(`[Agent Ops API] Deep resume failed for run ${runId}:`, err);
        });

        return NextResponse.json({
            success: true,
            data: { runId, status: 'in_progress', message: 'Decisions accepted — resuming execution.' },
        });
    } catch (error) {
        console.error('[Agent Ops API] Decisions error:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Internal server error',
        }, { status: 500 });
    }
}

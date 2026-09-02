/**
 * Agent Ops — Approve / Reject API
 *
 * POST /api/agent-ops/[runId]/approve
 * Body: { action: 'approve' | 'reject' }
 *
 * Source-agnostic: works for Slack, Jira, Discord, Telegram, Webhook, and API-triggered runs.
 * Resumes the LangGraph checkpoint on approve, cancels on reject.
 * Notifications are handled by the Gateway NotificationRouter via the event bus.
 */

import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { resumeApprovedRun } from '@/lib/agent-ops/agent-executor';
import { fanOutDecision, resolveDeepPendingActions } from '@/lib/agent-ops/deep-batch-decision';
import { resumeDeepRun } from '@/lib/agent-ops/deep-run-executor';
import { syntheticOutput } from '@/lib/agent/deep/hitl';
import type { ToolDecision } from '@/app/api/chat/decisions';
import { getGatewayEventBus } from '@/lib/gateway/event-bus';
import { getGatewayService } from '@/lib/gateway';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { finalizeScheduledRun } from '@/lib/agent-ops/scheduled-notifier';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    POST: { action: 'approve', subject: 'AgentOps' },
};

export async function POST(
    req: Request,
    { params }: { params: Promise<{ runId: string }> }
) {
    try {
        const { runId } = await params;
        const tenantId = await getSessionTenantId();
        const body = await req.json();
        const action: string = body.action; // 'approve' | 'reject'

        if (!action || !['approve', 'reject'].includes(action)) {
            return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400 });
        }

        // Pre-flight ownership check (D-06)
        const run = await agentOpsService.getRun(tenantId, runId);
        if (!run) {
            return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
        }
        if (run.status !== 'awaiting_approval') {
            return NextResponse.json({
                error: `Run is not awaiting approval (current status: ${run.status})`,
            }, { status: 409 });
        }

        const eventBus = getGatewayEventBus();

        // Lazily initialise the gateway service so the NotificationRouter is
        // wired to the singleton event bus. We don't call methods on it here —
        // we just need the router subscription infrastructure to exist.
        getGatewayService();

        // ── DEEP: fan the batch verdict out across every pending action ───────
        if (run.mode === 'deep') {
            const pendingResult = resolveDeepPendingActions(run);
            if (!pendingResult.ok) {
                return NextResponse.json({ error: pendingResult.error }, { status: 409 });
            }
            const pending = pendingResult.actions;

            // A rejection here RESUMES the graph (fanOutDecision turns it into
            // per-action 'reject'/'respond' decisions the agent adapts to) — it
            // is not a terminal outcome for the run. Writing eventType: 'final'
            // for it would render a "Final summary" mid-run in the timeline and
            // export, followed by a second, real final event once the run
            // actually finishes. Always 'planning' here; the run's own executor
            // emits the real terminal event when it settles.
            await agentOpsService.recordEvent({
                runId, tenantId,
                eventType: 'planning',
                node: 'deep_approval_gate',
                content: `All ${pending.length} pending action(s) ${action === 'approve' ? 'approved' : 'rejected'} via channel.`,
                metadata: { batch: true, tools: [...new Set(pending.map(p => p.toolName))] },
            });

            // Rejected actions never execute, so mirror their outcome into the
            // event log — otherwise their tool cards never settle in the
            // timeline/export. Mirrors decisions/route.ts's per-action synthetic
            // write; here every pending action shares the same batch verdict.
            if (action === 'reject') {
                for (const item of pending) {
                    const decision: ToolDecision = { toolCallId: item.toolCallId, approved: false };
                    await agentOpsService.recordEvent({
                        runId, tenantId, eventType: 'tool_result', node: 'tools',
                        toolName: item.toolName,
                        toolOutput: syntheticOutput(item, decision),
                        metadata: { toolCallId: item.toolCallId, synthetic: true, status: 'finished' },
                    });
                }
            }

            const session = await getAuthSession();
            AuditService.logUserAction({
                eventType: action === 'approve' ? 'agent.run.approved' : 'agent.run.rejected',
                severity: action === 'approve' ? 'high' : 'medium',
                apiRoute: 'POST /api/agent-ops/[runId]/approve',
                httpMethod: 'POST',
                action: action === 'approve' ? 'Approved Deep Agent Run' : 'Rejected Deep Agent Run',
                resourceType: 'AgentOps',
                resourceId: runId,
                resourceName: runId,
                user: session?.user?.email || 'unknown',
                userType: 'user',
                status: 'success',
                details: `${action} ${pending.length} deep action(s) on run ${runId}`,
                metadata: { tenantId, batch: true },
            }).catch(() => {});

            // Both verdicts resume the graph. A rejection is NOT a cancellation:
            // the agent receives the rejection messages and decides how to adapt.
            resumeDeepRun(run, fanOutDecision(pending, action as 'approve' | 'reject'), eventBus)
                .then(async () => {
                    const fresh = await agentOpsService.getRun(tenantId, runId);
                    if (fresh) await finalizeScheduledRun(fresh, { countRun: false });
                })
                .catch(err => console.error(`[Agent Ops API] Deep resume failed for run ${runId}:`, err));

            return NextResponse.json({
                runId,
                status: 'in_progress',
                message: `All pending actions ${action === 'approve' ? 'approved' : 'rejected'} — resuming execution.`,
            });
        }

        // ── REJECT ────────────────────────────────────────────────────────────
        if (action === 'reject') {
            await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
            await agentOpsService.recordEvent({
                runId, tenantId, eventType: 'final', node: 'approval_gate',
                content: 'Run rejected by user via Web UI.',
            });

            // Emit cancelled event so the NotificationRouter notifies the source channel
            eventBus.emit({ type: 'run:cancelled', runId, tenantId, timestamp: new Date(), data: {} });

            // Scheduled runs: refresh lastRunStatus and deliver the cancellation digest.
            // countRun: false — the trigger route already counted this run at first settle.
            await finalizeScheduledRun({ ...run, status: 'cancelled' }, { countRun: false });

            const session = await getAuthSession();
            AuditService.logUserAction({
                eventType: 'agent.run.rejected',
                severity: 'medium',
                apiRoute: 'POST /api/agent-ops/[runId]/approve',
                httpMethod: 'POST',
                action: 'Rejected Agent Run',
                resourceType: 'AgentOps',
                resourceId: runId,
                resourceName: runId,
                user: session?.user?.email || 'unknown',
                userType: 'user',
                status: 'success',
                details: `Rejected agent run ${runId}`,
                metadata: { tenantId },
            }).catch(() => {});

            return NextResponse.json({ runId, status: 'cancelled', message: 'Run rejected.' });
        }

        // ── APPROVE ───────────────────────────────────────────────────────────
        await agentOpsService.recordEvent({
            runId, tenantId, eventType: 'planning', node: 'approval_gate',
            content: 'Run approved by user via Web UI.',
        });

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.run.approved',
            severity: 'high',
            apiRoute: 'POST /api/agent-ops/[runId]/approve',
            httpMethod: 'POST',
            action: 'Approved Agent Run',
            resourceType: 'AgentOps',
            resourceId: runId,
            resourceName: runId,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Approved agent run ${runId}`,
            metadata: { tenantId },
        }).catch(() => {});

        // Fire-and-forget resume — the executor emits run:completed / run:failed
        // events to the bus, and the NotificationRouter dispatches them to the
        // originating channel adapter.
        resumeApprovedRun(run, eventBus)
            .then(async () => {
                // Scheduled runs: deliver the final digest to the task's channel.
                // countRun: false — the trigger route already counted this run at first settle.
                const freshRun = await agentOpsService.getRun(tenantId, runId);
                if (freshRun) await finalizeScheduledRun(freshRun, { countRun: false });
            })
            .catch((err) => {
                console.error(`[Agent Ops API] Resume failed for run ${runId}:`, err);
            });

        return NextResponse.json({ runId, status: 'in_progress', message: 'Run approved — resuming execution.' });

    } catch (error) {
        console.error('[Agent Ops API] Approve error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Internal server error',
        }, { status: 500 });
    }
}

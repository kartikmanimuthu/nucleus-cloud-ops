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
import { getGatewayEventBus } from '@/lib/gateway/event-bus';
import { getGatewayService } from '@/lib/gateway';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';

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

        // ── REJECT ────────────────────────────────────────────────────────────
        if (action === 'reject') {
            await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
            await agentOpsService.recordEvent({
                runId, tenantId, eventType: 'final', node: 'approval_gate',
                content: 'Run rejected by user via Web UI.',
            });

            // Emit cancelled event so the NotificationRouter notifies the source channel
            eventBus.emit({ type: 'run:cancelled', runId, tenantId, timestamp: new Date(), data: {} });

            const session = await getAuthSession();
            AuditService.logUserAction({
                eventType: 'agent.run.rejected',
                severity: 'medium',
                apiRoute: 'POST /api/agent-ops/[runId]/approve',
                httpMethod: 'POST',
                action: 'Rejected Agent Run',
                resourceType: 'agent',
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
            resourceType: 'agent',
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
        resumeApprovedRun(run, eventBus).catch((err) => {
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

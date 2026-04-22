/**
 * Agent Ops — Approve / Reject API
 *
 * POST /api/agent-ops/[runId]/approve
 * Body: { action: 'approve' | 'reject' }
 *
 * Source-agnostic: works for Slack, Jira, and API-triggered runs.
 * Resumes the LangGraph checkpoint on approve, cancels on reject.
 */

import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { resumeApprovedRun } from '@/lib/agent-ops/agent-executor';
import { postResultToSlack, postErrorToSlack, updateApprovalMessageInSlack } from '@/lib/agent-ops/slack-notifier';
import { postResultToJira, postErrorToJira } from '@/lib/agent-ops/jira-notifier';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { AgentOpsRun, SlackTriggerMeta, JiraTriggerMeta, JiraIntegrationConfig } from '@/lib/agent-ops/types';

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

        // ── REJECT ────────────────────────────────────────────────────────────
        if (action === 'reject') {
            await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
            await agentOpsService.recordEvent({
                runId, eventType: 'final', node: 'approval_gate',
                content: 'Run rejected by user via Web UI.',
            });

            // Notify source channel
            await notifySourceOnReject(run);

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
            runId, eventType: 'planning', node: 'approval_gate',
            content: 'Run approved by user via Web UI.',
        });

        // Notify source channel that approval happened
        await notifySourceOnApprove(run);

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

        // Fire-and-forget resume
        resumeApprovedRun(run)
            .then(async () => {
                const freshRun = await agentOpsService.getRun(tenantId, runId);
                await notifySourceOnComplete(freshRun || run);
            })
            .catch(async (err) => {
                await notifySourceOnError(run, err);
            });

        return NextResponse.json({ runId, status: 'in_progress', message: 'Run approved — resuming execution.' });

    } catch (error) {
        console.error('[Agent Ops API] Approve error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Internal server error',
        }, { status: 500 });
    }
}

// ─── Source-specific notification helpers ──────────────────────────────────────

async function notifySourceOnApprove(run: AgentOpsRun): Promise<void> {
    try {
        if (run.source === 'slack') {
            const trigger = run.trigger as SlackTriggerMeta;
            const msgTs = run.approvalRequest?.slackMessageTs;
            if (trigger.channelId && msgTs) {
                await updateApprovalMessageInSlack(trigger.channelId, msgTs, true, run.runId);
            }
        }
        // Jira: post a comment saying "approved"
        if (run.source === 'jira') {
            const trigger = run.trigger as JiraTriggerMeta;
            if (trigger.issueKey) {
                const { postApprovalResponseToJira } = await import('@/lib/agent-ops/jira-notifier');
                const jiraConfig = await TenantConfigService.getConfig<JiraIntegrationConfig>('agent-ops-jira').catch(() => undefined);
                await postApprovalResponseToJira(true, run.runId, trigger.issueKey, jiraConfig ?? undefined);
            }
        }
    } catch { /* non-fatal */ }
}

async function notifySourceOnReject(run: AgentOpsRun): Promise<void> {
    try {
        if (run.source === 'slack') {
            const trigger = run.trigger as SlackTriggerMeta;
            const msgTs = run.approvalRequest?.slackMessageTs;
            if (trigger.channelId && msgTs) {
                await updateApprovalMessageInSlack(trigger.channelId, msgTs, false, run.runId);
            }
        }
        if (run.source === 'jira') {
            const trigger = run.trigger as JiraTriggerMeta;
            if (trigger.issueKey) {
                const { postApprovalResponseToJira } = await import('@/lib/agent-ops/jira-notifier');
                const jiraConfig = await TenantConfigService.getConfig<JiraIntegrationConfig>('agent-ops-jira').catch(() => undefined);
                await postApprovalResponseToJira(false, run.runId, trigger.issueKey, jiraConfig ?? undefined);
            }
        }
    } catch { /* non-fatal */ }
}

async function notifySourceOnComplete(run: AgentOpsRun): Promise<void> {
    try {
        if (run.source === 'slack') {
            const trigger = run.trigger as SlackTriggerMeta;
            await postResultToSlack(run, trigger.responseUrl);
        }
        if (run.source === 'jira') {
            const trigger = run.trigger as JiraTriggerMeta;
            if (trigger.issueKey) {
                const jiraConfig = await TenantConfigService.getConfig<JiraIntegrationConfig>('agent-ops-jira').catch(() => undefined);
                await postResultToJira(run, trigger.issueKey, jiraConfig ?? undefined);
            }
        }
    } catch { /* non-fatal */ }
}

async function notifySourceOnError(run: AgentOpsRun, err: unknown): Promise<void> {
    try {
        if (run.source === 'slack') {
            const trigger = run.trigger as SlackTriggerMeta;
            await postErrorToSlack(err, run, trigger.responseUrl);
        }
        if (run.source === 'jira') {
            const trigger = run.trigger as JiraTriggerMeta;
            if (trigger.issueKey) {
                const jiraConfig = await TenantConfigService.getConfig<JiraIntegrationConfig>('agent-ops-jira').catch(() => undefined);
                await postErrorToJira(err, run, trigger.issueKey, jiraConfig ?? undefined);
            }
        }
    } catch { /* non-fatal */ }
}

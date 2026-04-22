/**
 * Slack Interactivity Endpoint
 *
 * POST /api/v1/trigger/slack/interactions
 *
 * Receives Slack Block Kit button interactions (approve / reject).
 * Must respond within 3 seconds — resume is fire-and-forget.
 *
 * Slack app setup required:
 *   Interactivity & Shortcuts → Request URL → <host>/api/v1/trigger/slack/interactions
 */

import { NextResponse } from 'next/server';
import { AuditService } from '@/lib/audit-service';
import { verifySlackSignature } from '@/lib/agent-ops/slack-validator';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { resumeApprovedRun } from '@/lib/agent-ops/agent-executor';
import { postResultToSlack, postErrorToSlack, updateApprovalMessageInSlack } from '@/lib/agent-ops/slack-notifier';
import { TenantConfigService } from '@/lib/tenant-config-service';
import type { SlackIntegrationConfig, AgentOpsRun, SlackTriggerMeta } from '@/lib/agent-ops/types';

export const maxDuration = 10;

export async function POST(req: Request) {
    const rawBody = await req.text();
    const timestamp = req.headers.get('x-slack-request-timestamp') ?? '';
    const signature = req.headers.get('x-slack-signature') ?? '';

    // 1. Verify Slack signature
    let signingSecretOverride: string | undefined;
    try {
        const slackConfig = await TenantConfigService.getConfig<SlackIntegrationConfig>('agent-ops-slack');
        if (slackConfig?.signingSecret) signingSecretOverride = slackConfig.signingSecret;
        if (slackConfig?.enabled === false) {
            return NextResponse.json({ error: 'Slack integration is disabled' }, { status: 403 });
        }
    } catch { /* fall through to env var */ }

    if (!verifySlackSignature(rawBody, timestamp, signature, signingSecretOverride)) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // 2. Parse Slack interactivity payload (URL-encoded `payload` field)
    let payload: any;
    try {
        const params = new URLSearchParams(rawBody);
        const payloadStr = params.get('payload');
        if (!payloadStr) throw new Error('Missing payload');
        payload = JSON.parse(payloadStr);
    } catch {
        return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    // 3. Only handle block_actions
    if (payload.type !== 'block_actions') {
        return new Response(null, { status: 200 });
    }

    const action = payload.actions?.[0];
    if (!action) return new Response(null, { status: 200 });

    const actionId: string = action.action_id;
    const value: string = action.value ?? '';

    // value format: "<runId>|<tenantId>"
    const [runId, tenantId] = value.split('|');
    if (!runId || !tenantId) {
        console.warn('[Slack Interactions] Malformed action value:', value);
        return new Response(null, { status: 200 });
    }

    const channelId: string = payload.channel?.id ?? '';
    const messageTs: string = payload.message?.ts ?? '';
    const responseUrl: string = payload.response_url ?? '';

    console.log(`[Slack Interactions] action=${actionId} runId=${runId} tenantId=${tenantId}`);

    // Audit: log the incoming Slack interaction
    AuditService.logResourceAction({
        eventType: 'trigger.slack.interaction',
        severity: 'low',
        apiRoute: 'POST /api/v1/trigger/slack/interactions',
        httpMethod: 'POST',
        source: 'external',
        action: 'Received Slack Interaction',
        resourceType: 'trigger',
        resourceId: runId,
        resourceName: 'Slack Interaction',
        status: 'success',
        details: `Received Slack interaction action=${actionId} for run ${runId}`,
        userType: 'system',
        metadata: { tenantId, actionId, channelId },
    }).catch(() => {});

    // 4. Fetch the run and validate it's still awaiting approval
    const run = await agentOpsService.findAwaitingApprovalRun(runId);

    if (!run) {
        // Run already processed or not found — update the message to reflect this
        if (channelId && messageTs) {
            await updateApprovalMessageInSlack(channelId, messageTs, false, runId)
                .catch(() => { /* non-fatal */ });
        }
        return NextResponse.json({ text: '⚠️ This approval request has already been handled or expired.' });
    }

    // 5. Handle approve
    if (actionId === 'agent_ops_approve') {
        // Update Block Kit message immediately (within 3s window)
        if (channelId && messageTs) {
            await updateApprovalMessageInSlack(channelId, messageTs, true, runId)
                .catch(() => { /* non-fatal */ });
        }

        // Fire-and-forget resume
        resumeApprovedRun(run)
            .then(async () => {
                const freshRun = await agentOpsService.getRun(tenantId, runId);
                const trigger = (freshRun || run).trigger as SlackTriggerMeta;
                await postResultToSlack((freshRun || run) as AgentOpsRun, trigger.responseUrl);
            })
            .catch((err) => {
                const trigger = run.trigger as SlackTriggerMeta;
                postErrorToSlack(err, run, trigger.responseUrl);
            });

        return NextResponse.json({ text: '✅ Approved! Executing now...' });
    }

    // 6. Handle reject
    if (actionId === 'agent_ops_reject') {
        await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
        await agentOpsService.recordEvent({
            runId, eventType: 'final', node: 'approval_gate',
            content: 'Run rejected by user via Slack.',
        });

        if (channelId && messageTs) {
            await updateApprovalMessageInSlack(channelId, messageTs, false, runId)
                .catch(() => { /* non-fatal */ });
        }

        return NextResponse.json({ text: '❌ Rejected — run cancelled.' });
    }

    // Unknown action — ignore
    return new Response(null, { status: 200 });
}

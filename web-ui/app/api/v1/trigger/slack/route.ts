/**
 * Slack Trigger Endpoint
 *
 * POST /api/v1/trigger/slack
 *
 * Accepts Slack slash commands, validates the signature, creates an agent-ops
 * run, and kicks off the agent asynchronously (fire-and-forget).
 * Returns an ephemeral acknowledgement within Slack's 3-second window.
 */

import { NextResponse } from 'next/server';
import { verifySlackSignature, parseSlackSlashCommand } from '@/lib/agent-ops/slack-validator';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';
import { postResultToSlack, postErrorToSlack } from '@/lib/agent-ops/slack-notifier';
import { TenantConfigService } from '@/lib/tenant-config-service';
import type { SlackIntegrationConfig, AgentOpsRun } from '@/lib/agent-ops/types';

export const maxDuration = 10;

export async function POST(req: Request) {
    // Read raw body as text — must happen before any parsing for HMAC verification
    const rawBody = await req.text();
    const timestamp = req.headers.get('x-slack-request-timestamp') ?? '';
    const signature = req.headers.get('x-slack-signature') ?? '';

    // 1. Fetch signing secret from DynamoDB (falls back to env var inside verifySlackSignature)
    let signingSecretOverride: string | undefined;
    let slackConfig: SlackIntegrationConfig | null | undefined;
    try {
        slackConfig = await TenantConfigService.getConfig<SlackIntegrationConfig>('agent-ops-slack');
        if (slackConfig?.signingSecret) {
            signingSecretOverride = slackConfig.signingSecret;
        }
        // If integration is explicitly disabled, reject
        if (slackConfig && slackConfig.enabled === false) {
            return NextResponse.json({ error: 'Slack integration is disabled' }, { status: 403 });
        }
    } catch (dbErr) {
        console.warn('[Slack Trigger] Failed to load Slack config from DynamoDB, using env var fallback:', dbErr);
    }

    // 2. Verify Slack signature
    if (!verifySlackSignature(rawBody, timestamp, signature, signingSecretOverride)) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // 3. Parse slash command payload
    const payload = parseSlackSlashCommand(rawBody);

    // 4. Guard against empty task description
    if (payload.text.trim() === '') {
        return NextResponse.json(
            {
                response_type: 'ephemeral',
                text: '⚠️ Please provide a task description. Example: /cloud-ops Check Lambda configurations',
            },
            { status: 200 },
        );
    }

    const tenantId = payload.team_id;
    const threadTs: string | undefined = (payload as any).thread_ts || undefined;

    // 5. Check if this message is a reply to an awaiting_input run (thread-based HIL)
    if (threadTs) {
        const awaitingRun = await agentOpsService.findAwaitingRunBySlackThread(payload.channel_id, threadTs);

        if (awaitingRun) {
            console.log(`[Slack Trigger] Resuming awaiting_input run ${awaitingRun.runId} via thread ${threadTs}`);

            const clarificationContext = awaitingRun.clarification
                ? `\n\n---\nOriginal clarification question: ${awaitingRun.clarification.question}\nUser reply: ${payload.text.trim()}`
                : `\n\n---\nUser clarification: ${payload.text.trim()}`;

            const enrichedTask = awaitingRun.taskDescription + clarificationContext;
            await agentOpsService.updateRunStatus(tenantId, awaitingRun.runId, 'in_progress');

            const resumedRun = { ...awaitingRun, taskDescription: enrichedTask };
            executeAgentRun(resumedRun)
                .then(async () => {
                    const freshRun = await agentOpsService.getRun(tenantId, awaitingRun.runId);
                    await postResultToSlack((freshRun as AgentOpsRun) || (resumedRun as AgentOpsRun), payload.response_url);
                })
                .catch((err) => postErrorToSlack(err, awaitingRun.runId, payload.response_url));

            return NextResponse.json(
                {
                    response_type: 'ephemeral',
                    text: `▶️ Resuming run \`${awaitingRun.runId}\` with your clarification...`,
                },
                { status: 200 },
            );
        }
    }

    // 6. Create a new run record (team_id used as tenantId for multi-tenancy)
    const run = await agentOpsService.createRun({
        tenantId,
        source: 'slack',
        taskDescription: payload.text.trim(),
        mode: 'fast',
        trigger: {
            userId: payload.user_id,
            userName: payload.user_name,
            channelId: payload.channel_id,
            channelName: payload.channel_name,
            responseUrl: payload.response_url,
            teamId: payload.team_id,
            threadTs,
        },
    });

    // 6.5. Post initial message using API to start a thread (if botToken is available)
    let initialMessageTs: string | undefined;
    if (slackConfig?.botToken && !threadTs) {
        try {
            const startMsgRes = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${slackConfig.botToken}`,
                },
                body: JSON.stringify({
                    channel: payload.channel_id,
                    text: '🚀 Agent Ops Started\nTask: ' + run.taskDescription + '\nRun ID: `' + run.runId + '`',
                }),
            });
            const startMsgData = await startMsgRes.json();
            if (startMsgData.ok && startMsgData.ts) {
                initialMessageTs = startMsgData.ts;
                (run.trigger as any).threadTs = initialMessageTs;
                await agentOpsService.updateRunTrigger(tenantId, run.runId, run.trigger);
            }
        } catch (postErr) {
            console.warn('[Slack Trigger] Failed to post initial message via API:', postErr);
        }
    }

    // 7. Fire-and-forget: execute agent, then post result/error back to Slack
    executeAgentRun(run)
        .then(async () => {
            const freshRun = await agentOpsService.getRun(tenantId, run.runId);
            await postResultToSlack(freshRun || run, payload.response_url);
        })
        .catch((err) => postErrorToSlack(err, run.runId, payload.response_url));

    // 8. Immediate acknowledgement — must return within Slack's 3-second window
    if (initialMessageTs) {
        // Acknowledge quietly, we already posted the message
        return new Response(null, { status: 200 });
    }

    return NextResponse.json(
        {
            response_type: 'ephemeral',
            text: '🚀 Agent Ops Started\nTask: ' + run.taskDescription + '\nRun ID: `' + run.runId + '`',
        },
        { status: 200 },
    );
}

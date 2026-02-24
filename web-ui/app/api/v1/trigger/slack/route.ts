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
import type { SlackIntegrationConfig } from '@/lib/agent-ops/types';

export const maxDuration = 10;

export async function POST(req: Request) {
    // Read raw body as text — must happen before any parsing for HMAC verification
    const rawBody = await req.text();
    const timestamp = req.headers.get('x-slack-request-timestamp') ?? '';
    const signature = req.headers.get('x-slack-signature') ?? '';

    // 1. Fetch signing secret from DynamoDB (falls back to env var inside verifySlackSignature)
    let signingSecretOverride: string | undefined;
    try {
        const slackConfig = await TenantConfigService.getConfig<SlackIntegrationConfig>('agent-ops-slack');
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

    // 5. Create run record (team_id used as tenantId for multi-tenancy)
    const run = await agentOpsService.createRun({
        tenantId: payload.team_id,
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
        },
    });

    // 6. Fire-and-forget: execute agent, then post result/error back to Slack
    executeAgentRun(run)
        .then(() => postResultToSlack(run, payload.response_url))
        .catch((err) => postErrorToSlack(err, run.runId, payload.response_url));

    // 7. Immediate acknowledgement — must return within Slack's 3-second window
    return NextResponse.json(
        {
            response_type: 'ephemeral',
            text: '🚀 Agent Ops Started\nTask: ' + run.taskDescription + '\nRun ID: `' + run.runId + '`',
        },
        { status: 200 },
    );
}

/**
 * Slack result/error notifier
 *
 * Posts agent run results and errors back to Slack via response_url.
 * Errors are swallowed — the run record in PostgreSQL already reflects final status.
 */

import { TenantConfigService } from '../tenant-config-service';
import type { AgentOpsRun, SlackIntegrationConfig } from './types';

async function postToSlackThreadOrWebhook(
    text: string,
    responseUrl: string,
    run?: AgentOpsRun
): Promise<void> {
    try {
        let postedToThread = false;

        if (run && run.trigger && 'threadTs' in run.trigger && run.trigger.threadTs) {
            const threadTs = run.trigger.threadTs;
            const channelId = run.trigger.channelId;

            if (channelId) {
                const config = await TenantConfigService.getConfig<SlackIntegrationConfig>('agent-ops-slack').catch(() => null);
                if (config?.botToken) {
                    const res = await fetch('https://slack.com/api/chat.postMessage', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${config.botToken}`,
                        },
                        body: JSON.stringify({
                            channel: channelId,
                            thread_ts: threadTs,
                            text,
                        }),
                    });

                    if (res.ok) {
                        const data = await res.json();
                        if (data.ok) {
                            postedToThread = true;
                        } else {
                            console.warn('[slack-notifier] Thread reply failed:', data.error);
                        }
                    }
                }
            }
        }

        if (!postedToThread) {
            await fetch(responseUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    response_type: 'in_channel',
                    text,
                }),
            });
        }
    } catch (err) {
        console.error('[slack-notifier] Failed to post to Slack:', err);
    }
}

export async function postResultToSlack(run: AgentOpsRun, responseUrl: string): Promise<void> {
    const summary = run.result?.summary ?? '(no summary)';
    await postToSlackThreadOrWebhook(`✅ Complete\n${summary}`, responseUrl, run);
}

export async function postClarificationToSlack(
    question: string,
    run: AgentOpsRun,
    responseUrl: string,
): Promise<void> {
    const text = `❓ *Clarification needed* (Run \`${run.runId}\`)\n\n${question}\n\n_Reply with the information above to continue._`;
    await postToSlackThreadOrWebhook(text, responseUrl, run);
}

/**
 * Post a Block Kit approval request to Slack with Approve / Reject buttons.
 * Returns the message ts (for later updates) or undefined on failure.
 */
export async function postApprovalRequestToSlack(
    run: AgentOpsRun,
    planSteps: string[],
    pendingTools?: string[],
): Promise<string | undefined> {
    const trigger = run.trigger as any;
    const channelId = trigger?.channelId;
    const threadTs = trigger?.threadTs;

    if (!channelId) {
        console.warn('[slack-notifier] postApprovalRequestToSlack: no channelId on trigger');
        return undefined;
    }

    const config = await TenantConfigService.getConfig<SlackIntegrationConfig>('agent-ops-slack').catch(() => null);
    if (!config?.botToken) {
        console.warn('[slack-notifier] postApprovalRequestToSlack: no botToken configured');
        return undefined;
    }

    const planText = planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const toolsText = pendingTools?.length
        ? `\n\n*Tools that will execute:* ${pendingTools.map(t => `\`${t}\``).join(', ')}`
        : '';

    // Encode runId + tenantId in button value for correlation in the interactions handler
    const approveValue = `${run.runId}|${run.tenantId}`;
    const rejectValue = `${run.runId}|${run.tenantId}`;

    const blocks = [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `🤖 *Agent Ops — Approval Required*\n\n*Task:* ${run.taskDescription}${toolsText}`,
            },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*Execution Plan:*\n\`\`\`\n${planText}\n\`\`\``,
            },
        },
        {
            type: 'context',
            elements: [
                {
                    type: 'mrkdwn',
                    text: `Run ID: \`${run.runId}\``,
                },
            ],
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '✅ Approve', emoji: true },
                    style: 'primary',
                    action_id: 'agent_ops_approve',
                    value: approveValue,
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '❌ Reject', emoji: true },
                    style: 'danger',
                    action_id: 'agent_ops_reject',
                    value: rejectValue,
                },
            ],
        },
    ];

    try {
        const res = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.botToken}`,
            },
            body: JSON.stringify({
                channel: channelId,
                ...(threadTs && { thread_ts: threadTs }),
                blocks,
                text: `Approval required for Agent Ops run \`${run.runId}\``,
            }),
        });

        const data = await res.json();
        if (data.ok) {
            console.log(`[slack-notifier] Approval Block Kit posted, ts=${data.ts}`);
            return data.ts as string;
        } else {
            console.warn('[slack-notifier] Block Kit post failed:', data.error);
        }
    } catch (err) {
        console.error('[slack-notifier] postApprovalRequestToSlack error:', err);
    }
    return undefined;
}

/**
 * Update an existing Block Kit approval message to show approved/rejected state.
 */
export async function updateApprovalMessageInSlack(
    channelId: string,
    messageTs: string,
    approved: boolean,
    runId: string,
): Promise<void> {
    const config = await TenantConfigService.getConfig<SlackIntegrationConfig>('agent-ops-slack').catch(() => null);
    if (!config?.botToken) return;

    const statusText = approved
        ? '✅ *Approved* — executing now...'
        : '❌ *Rejected* — run cancelled.';

    try {
        await fetch('https://slack.com/api/chat.update', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.botToken}`,
            },
            body: JSON.stringify({
                channel: channelId,
                ts: messageTs,
                blocks: [
                    {
                        type: 'section',
                        text: { type: 'mrkdwn', text: `${statusText}\nRun ID: \`${runId}\`` },
                    },
                ],
                text: statusText,
            }),
        });
    } catch (err) {
        console.error('[slack-notifier] updateApprovalMessageInSlack error:', err);
    }
}

export async function postErrorToSlack(
    err: unknown,
    runOrId: AgentOpsRun | string,
    responseUrl: string,
): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    const run = typeof runOrId === 'object' ? runOrId : undefined;
    await postToSlackThreadOrWebhook(`❌ Agent Ops failed: ${msg}`, responseUrl, run);
}

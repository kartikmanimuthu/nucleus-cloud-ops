/**
 * Slack result/error notifier
 *
 * Posts agent run results and errors back to Slack via response_url.
 * Errors are swallowed — the run record in DynamoDB already reflects final status.
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

export async function postErrorToSlack(
    err: unknown,
    runOrId: AgentOpsRun | string,
    responseUrl: string,
): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    const run = typeof runOrId === 'object' ? runOrId : undefined;
    await postToSlackThreadOrWebhook(`❌ Agent Ops failed: ${msg}`, responseUrl, run);
}

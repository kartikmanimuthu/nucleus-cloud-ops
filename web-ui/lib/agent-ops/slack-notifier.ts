/**
 * Slack result/error notifier
 *
 * Posts agent run results and errors back to Slack via response_url.
 * Errors are swallowed — the run record in DynamoDB already reflects final status.
 */

import type { AgentOpsRun } from './types';

export async function postResultToSlack(run: AgentOpsRun, responseUrl: string): Promise<void> {
    const summary = run.result?.summary ?? '(no summary)';
    try {
        await fetch(responseUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                response_type: 'in_channel',
                text: `✅ Complete\n${summary}`,
            }),
        });
    } catch (err) {
        console.error('[slack-notifier] Failed to post result to Slack:', err);
    }
}

export async function postErrorToSlack(
    err: unknown,
    _runId: string,
    responseUrl: string,
): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    try {
        await fetch(responseUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                response_type: 'in_channel',
                text: `❌ Agent Ops failed: ${msg}`,
            }),
        });
    } catch (fetchErr) {
        console.error('[slack-notifier] Failed to post error to Slack:', fetchErr);
    }
}

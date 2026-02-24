/**
 * Jira Result Notifier
 *
 * Posts agent run results and errors back to a Jira issue as comments
 * using the Jira REST API v3.
 *
 * Required env vars:
 *   JIRA_BASE_URL      — e.g. https://your-org.atlassian.net
 *   JIRA_USER_EMAIL    — Atlassian account email for Basic Auth
 *   JIRA_API_TOKEN     — Atlassian API token
 */

import type { AgentOpsRun, JiraIntegrationConfig } from './types';

function resolveConfig(config?: JiraIntegrationConfig) {
    return {
        baseUrl: config?.baseUrl || process.env.JIRA_BASE_URL || '',
        userEmail: config?.userEmail || process.env.JIRA_USER_EMAIL || '',
        apiToken: config?.apiToken || process.env.JIRA_API_TOKEN || '',
    };
}

function buildAuthHeader(userEmail: string, apiToken: string): string {
    const credentials = Buffer.from(`${userEmail}:${apiToken}`).toString('base64');
    return `Basic ${credentials}`;
}

/**
 * Post a comment to a Jira issue using the Atlassian Document Format (ADF).
 */
async function postComment(issueKey: string, bodyText: string, config?: JiraIntegrationConfig): Promise<void> {
    const { baseUrl, userEmail, apiToken } = resolveConfig(config);

    if (!baseUrl || !userEmail || !apiToken) {
        console.warn('[JiraNotifier] Jira API not configured — skipping comment post');
        return;
    }

    const url = `${baseUrl}/rest/api/3/issue/${issueKey}/comment`;

    const body = {
        body: {
            type: 'doc',
            version: 1,
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: bodyText }],
                },
            ],
        },
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': buildAuthHeader(userEmail, apiToken),
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Jira API error ${res.status}: ${text}`);
    }
}

/**
 * Post a successful agent run result as a Jira comment.
 */
export async function postResultToJira(run: AgentOpsRun, issueKey: string, config?: JiraIntegrationConfig): Promise<void> {
    const summary = run.result?.summary ?? '(no summary)';
    const tools = run.result?.toolsUsed?.join(', ') || 'none';
    const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '—';

    const text = [
        `✅ Agent Ops Run Completed`,
        `Run ID: ${run.runId}`,
        `Duration: ${duration}`,
        `Tools used: ${tools}`,
        ``,
        summary,
    ].join('\n');

    try {
        await postComment(issueKey, text, config);
    } catch (err) {
        console.error('[JiraNotifier] Failed to post result:', err);
    }
}

/**
 * Post a failed agent run error as a Jira comment.
 */
export async function postErrorToJira(err: unknown, run: AgentOpsRun, issueKey: string, config?: JiraIntegrationConfig): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);

    const text = [
        `❌ Agent Ops Run Failed`,
        `Run ID: ${run.runId}`,
        `Error: ${msg}`,
    ].join('\n');

    try {
        await postComment(issueKey, text, config);
    } catch (fetchErr) {
        console.error('[JiraNotifier] Failed to post error:', fetchErr);
    }
}

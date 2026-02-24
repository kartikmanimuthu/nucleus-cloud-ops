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

import type { AgentOpsRun } from './types';

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || '';
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';

function getAuthHeader(): string {
    const credentials = Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
    return `Basic ${credentials}`;
}

function isConfigured(): boolean {
    return Boolean(JIRA_BASE_URL && JIRA_USER_EMAIL && JIRA_API_TOKEN);
}

/**
 * Post a comment to a Jira issue using the Atlassian Document Format (ADF).
 */
async function postComment(issueKey: string, bodyText: string): Promise<void> {
    if (!isConfigured()) {
        console.warn('[JiraNotifier] Jira API not configured — skipping comment post');
        return;
    }

    const url = `${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/comment`;

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
            'Authorization': getAuthHeader(),
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
export async function postResultToJira(run: AgentOpsRun, issueKey: string): Promise<void> {
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
        await postComment(issueKey, text);
    } catch (err) {
        console.error('[JiraNotifier] Failed to post result:', err);
    }
}

/**
 * Post a failed agent run error as a Jira comment.
 */
export async function postErrorToJira(err: unknown, run: AgentOpsRun, issueKey: string): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);

    const text = [
        `❌ Agent Ops Run Failed`,
        `Run ID: ${run.runId}`,
        `Error: ${msg}`,
    ].join('\n');

    try {
        await postComment(issueKey, text);
    } catch (fetchErr) {
        console.error('[JiraNotifier] Failed to post error:', fetchErr);
    }
}

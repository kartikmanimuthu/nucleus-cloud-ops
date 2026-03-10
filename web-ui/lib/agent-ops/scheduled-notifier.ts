/**
 * Scheduled Notifier — Post-run notifications for scheduled tasks.
 *
 * Reuses slack-notifier and jira-notifier patterns.
 */

import type { ScheduledTask, AgentOpsRun, SlackIntegrationConfig, JiraIntegrationConfig } from './types';

export async function notifyScheduledRunResult(task: ScheduledTask, run: AgentOpsRun): Promise<void> {
    const { notification } = task;
    if (notification.type === 'none' || !notification.type) return;

    const summary = run.result?.summary ?? run.error ?? '(no summary)';
    const status = run.status === 'completed' ? '✅' : '❌';
    const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '—';
    const text = `${status} *Scheduled Task: ${task.name}*\nRun ID: \`${run.runId}\`  |  Duration: ${duration}\n\n${summary}`;

    try {
        if (notification.type === 'slack' && notification.channelId) {
            await postToSlackChannel(notification.channelId, text, run.tenantId);
        } else if (notification.type === 'jira' && notification.issueKey) {
            await postToJiraIssue(notification.issueKey, text, run.tenantId);
        }
    } catch (err) {
        console.error('[ScheduledNotifier] Notification failed (non-fatal):', err);
    }
}

async function postToSlackChannel(channelId: string, text: string, tenantId: string): Promise<void> {
    const { TenantConfigService } = await import('../tenant-config-service');
    const config = await TenantConfigService.getConfig<SlackIntegrationConfig>('agent-ops-slack', tenantId).catch(() => null);
    if (!config?.botToken) {
        console.warn('[ScheduledNotifier] No Slack bot token configured');
        return;
    }
    const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.botToken}` },
        body: JSON.stringify({ channel: channelId, text }),
    });
    const data = await res.json();
    if (!data.ok) console.warn('[ScheduledNotifier] Slack post failed:', data.error);
}

async function postToJiraIssue(issueKey: string, text: string, tenantId: string): Promise<void> {
    const { TenantConfigService } = await import('../tenant-config-service');
    const config = await TenantConfigService.getConfig<JiraIntegrationConfig>('agent-ops-jira', tenantId).catch(() => null);
    const baseUrl = config?.baseUrl || process.env.JIRA_BASE_URL || '';
    const userEmail = config?.userEmail || process.env.JIRA_USER_EMAIL || '';
    const apiToken = config?.apiToken || process.env.JIRA_API_TOKEN || '';
    if (!baseUrl || !userEmail || !apiToken) {
        console.warn('[ScheduledNotifier] Jira not configured');
        return;
    }
    const credentials = Buffer.from(`${userEmail}:${apiToken}`).toString('base64');
    await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({
            body: {
                type: 'doc', version: 1,
                content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
            },
        }),
    });
}

/**
 * Jira Channel Adapter
 *
 * Implements ChannelAdapter for Jira automation rules and native webhooks.
 * Consolidates logic from jira-notifier.ts and jira-validator.ts into the
 * unified gateway pattern.
 */

import type { NextRequest } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { env } from '@/env';
import { getUsableAccessToken } from '@/lib/connectors/connection-service';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { buildDashboardRespondUrl } from '@/lib/gateway/utils/dashboard-url';
import type {
    ChannelAdapter,
    ChannelType,
    DeliveryMode,
    HilCapabilities,
    GatewayMessage,
    ReplyContext,
} from '@/lib/gateway/types';
import type {
    AgentOpsRun,
    AgentOpsEvent,
    JiraIntegrationConfig,
    JiraTriggerMeta,
} from '@/lib/agent-ops/types';

// ─── ADF node types ────────────────────────────────────────────────────

interface AdfNode {
    type: string;
    text?: string;
    attrs?: Record<string, string>;
    content?: AdfNode[];
}

interface JiraWebhookPayload {
    webhookEvent?: string;
    issue?: {
        key: string;
        fields?: {
            summary: string;
            description?: string;
            project?: { key: string };
            issuetype?: { name: string };
            reporter?: { displayName: string; emailAddress?: string };
        };
    };
    comment?: {
        id: string;
        body?: string | AdfNode;
        author?: { displayName: string; accountId: string };
    };
    automation?: { ruleId: string; ruleName: string };
    taskDescription?: string;
    accountId?: string;
    selectedSkill?: string;
    mode?: string;
}

// ─── Body cache ────────────────────────────────────────────────────────

const bodyCache = new WeakMap<NextRequest, string>();

async function readBody(req: NextRequest): Promise<string> {
    const cached = bodyCache.get(req);
    if (cached !== undefined) return cached;
    const text = await req.text();
    bodyCache.set(req, text);
    return text;
}

// ─── Adapter ───────────────────────────────────────────────────────────

export class JiraAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'jira';
    readonly deliveryMode: DeliveryMode = 'callback';
    readonly hilCapabilities: HilCapabilities = {
        clarification: true,
        approvalButtons: false,
        threadedReplies: true,
    };

    // ─── Inbound ──────────────────────────────────────────────────────

    async validateRequest(req: NextRequest): Promise<boolean> {
        const authHeader = req.headers.get('authorization') || req.headers.get('x-webhook-secret') || '';
        const url = new URL(req.url);
        const querySecret = url.searchParams.get('secret');

        // Try to resolve tenant from body (best-effort, don't fail if body is unreadable)
        let webhookSecret = '';
        try {
            const body = await readBody(req);
            const payload: JiraWebhookPayload = JSON.parse(body);
            const tenantId = payload.issue?.fields?.project?.key || 'default';
            const config = await TenantConfigService.getConfig<JiraIntegrationConfig>(
                'agent-ops-jira',
                tenantId,
            ).catch(() => null);
            webhookSecret = config?.webhookSecret || '';
        } catch { /* ignore parse errors */ }

        // Env var fallback
        if (!webhookSecret) {
            webhookSecret = env.JIRA_WEBHOOK_SECRET || '';
        }

        if (!webhookSecret) {
            console.error('[JiraAdapter] Webhook secret not configured');
            return false;
        }

        // Check Authorization / x-webhook-secret header
        if (authHeader) {
            const secret = authHeader.startsWith('Bearer ')
                ? authHeader.slice(7)
                : authHeader;
            if (secret === webhookSecret) return true;
        }

        // Fall back to ?secret= query param (native Jira webhooks)
        if (querySecret && querySecret === webhookSecret) return true;

        return false;
    }

    async parseInbound(req: NextRequest): Promise<GatewayMessage> {
        const body = await readBody(req);
        const payload: JiraWebhookPayload = JSON.parse(body);

        const issueKey = payload.issue?.key || '';
        const projectKey = payload.issue?.fields?.project?.key || '';
        const reporter = payload.issue?.fields?.reporter?.displayName || '';
        const issueType = payload.issue?.fields?.issuetype?.name;

        // Load config for bot account ID detection
        const config = await this.loadConfig(projectKey || 'default');
        const botAccountId = config?.botAccountId;

        let taskDescription = '';
        let replyContext: ReplyContext | undefined;

        // ── Comment routing (priority order) ────────────────────────
        if (payload.comment) {
            const commentAuthorId = payload.comment.author?.accountId;
            const commentText = this.extractCommentText(payload.comment);
            const normalizedText = commentText.toLowerCase().trim();

            // 1. Skip bot's own comments
            if (botAccountId && commentAuthorId === botAccountId) {
                taskDescription = '';
            }
            // 2. APPROVE/REJECT keywords on awaiting_approval run
            else if (/^(approve|approved|reject|rejected)$/i.test(normalizedText)) {
                const awaitingRun = await agentOpsService.findAwaitingApprovalRunByJiraIssue(issueKey);
                if (awaitingRun) {
                    const action = normalizedText.startsWith('approve') ? 'approve' : 'reject';
                    replyContext = {
                        runId: awaitingRun.runId,
                        action: action as ReplyContext['action'],
                        tenantId: awaitingRun.tenantId,
                    };
                } else {
                    taskDescription = commentText;
                }
            }
            // 3. Clarification reply on awaiting_input run
            else {
                const awaitingInputRun = await agentOpsService.findAwaitingRunByJiraIssue(issueKey);
                if (awaitingInputRun) {
                    replyContext = {
                        runId: awaitingInputRun.runId,
                        action: 'clarification_response',
                        content: commentText,
                        tenantId: awaitingInputRun.tenantId,
                    };
                }
                // 4. @bot mention — extract text without mention
                else if (this.isBotMention(payload.comment, botAccountId)) {
                    taskDescription = this.extractCommentTextWithoutMention(payload.comment.body);
                }
                // 5. Regular comment — use as task description
                else {
                    taskDescription = commentText;
                }
            }
        }
        // ── No comment — use automation rule or issue fields ────────
        else {
            // 5. Automation rule with taskDescription
            if (payload.taskDescription) {
                taskDescription = payload.taskDescription;
            }
            // 6. Issue summary/description fallback
            else {
                const summary = payload.issue?.fields?.summary || '';
                const description = payload.issue?.fields?.description || '';
                taskDescription = summary && description
                    ? `${summary}\n\n${description}`
                    : summary || description || 'No task description provided';
            }
        }

        const channelMeta: JiraTriggerMeta = {
            issueKey,
            projectKey,
            reporter,
            issueType,
            webhookId: payload.comment?.id,
        };

        return {
            channelType: 'jira',
            tenantId: projectKey || 'default',
            taskDescription,
            mode: payload.mode as GatewayMessage['mode'],
            accountId: payload.accountId,
            selectedSkill: payload.selectedSkill,
            replyContext,
            channelMeta: channelMeta as unknown as Record<string, unknown>,
        };
    }

    async sendAck(_req: NextRequest, runId: string): Promise<Response> {
        return new Response(
            JSON.stringify({
                runId,
                status: 'queued',
                message: 'Agent Ops run started',
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            },
        );
    }

    // ─── Outbound ─────────────────────────────────────────────────────

    async sendResult(run: AgentOpsRun, _events: AgentOpsEvent[]): Promise<void> {
        const trigger = run.trigger as JiraTriggerMeta;
        const issueKey = trigger?.issueKey;
        if (!issueKey) return;

        const config = await this.loadConfig(run.tenantId);
        const summary = run.result?.summary ?? '(no summary)';
        const tools = run.result?.toolsUsed?.join(', ') || 'none';
        const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '—';

        const text = [
            '✅ Agent Ops Run Completed',
            `Run ID: ${run.runId}`,
            `Duration: ${duration}`,
            `Tools used: ${tools}`,
            '',
            summary,
        ].join('\n');

        await this.postComment(run.tenantId, issueKey, text, config);
    }

    async sendError(run: AgentOpsRun, error: string): Promise<void> {
        const trigger = run.trigger as JiraTriggerMeta;
        const issueKey = trigger?.issueKey;
        if (!issueKey) return;

        const config = await this.loadConfig(run.tenantId);
        const text = [
            '❌ Agent Ops Run Failed',
            `Run ID: ${run.runId}`,
            `Error: ${error}`,
        ].join('\n');

        await this.postComment(run.tenantId, issueKey, text, config);
    }

    async sendClarification(run: AgentOpsRun, question: string): Promise<void> {
        const trigger = run.trigger as JiraTriggerMeta;
        const issueKey = trigger?.issueKey;
        if (!issueKey) return;

        const config = await this.loadConfig(run.tenantId);
        const dashboardUrl = buildDashboardRespondUrl(run.runId);

        const text = [
            '❓ Agent Ops — Clarification Needed',
            `Run ID: ${run.runId}`,
            '',
            question,
            '',
            'Please reply to this issue with the information above to resume the agent run.',
            '',
            `Or respond via the dashboard: ${dashboardUrl}`,
        ].join('\n');

        await this.postComment(run.tenantId, issueKey, text, config);
    }

    async sendApprovalRequest(
        run: AgentOpsRun,
        planSteps?: string[],
        pendingTools?: string[],
    ): Promise<void> {
        const trigger = run.trigger as JiraTriggerMeta;
        const issueKey = trigger?.issueKey;
        if (!issueKey) return;

        const config = await this.loadConfig(run.tenantId);
        const dashboardUrl = buildDashboardRespondUrl(run.runId);
        const planText = (planSteps ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n');
        const toolsText = pendingTools?.length
            ? `\nTools that will execute: ${pendingTools.join(', ')}`
            : '';

        const text = [
            '\u{1F916} Agent Ops — Approval Required',
            `Run ID: ${run.runId}`,
            `Task: ${run.taskDescription}`,
            '',
            'Execution Plan:',
            planText,
            toolsText,
            '',
            'Reply with "APPROVE" or "REJECT" to this issue to continue.',
            '',
            `Or use the dashboard for button-based approval: ${dashboardUrl}`,
        ].join('\n');

        await this.postComment(run.tenantId, issueKey, text, config);
    }

    // ─── Config ───────────────────────────────────────────────────────

    async getConfig(tenantId: string): Promise<Record<string, unknown>> {
        const config = await this.loadConfig(tenantId);
        return (config as unknown as Record<string, unknown>) ?? {};
    }

    // ─── Private helpers ──────────────────────────────────────────────

    private async loadConfig(tenantId: string): Promise<JiraIntegrationConfig | null> {
        return TenantConfigService.getConfig<JiraIntegrationConfig>(
            'agent-ops-jira',
            tenantId,
        ).catch(() => null);
    }

    private resolveApiConfig(config: JiraIntegrationConfig | null) {
        return {
            baseUrl: config?.baseUrl || env.JIRA_BASE_URL || '',
            userEmail: config?.userEmail || env.JIRA_USER_EMAIL || '',
            apiToken: config?.apiToken || env.JIRA_API_TOKEN || '',
        };
    }

    private buildAuthHeader(userEmail: string, apiToken: string): string {
        return `Basic ${Buffer.from(`${userEmail}:${apiToken}`).toString('base64')}`;
    }

    private buildAdfBody(bodyText: string) {
        return {
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
    }

    /**
     * Post a comment to a Jira issue using Atlassian Document Format (ADF).
     *
     * Prefers the tenant's active OAuth connection (Bearer token against the
     * Atlassian API gateway); falls back to the manual Basic-auth
     * userEmail:apiToken / env config when no connection exists or the OAuth
     * call returns 401.
     */
    private async postComment(
        tenantId: string,
        issueKey: string,
        bodyText: string,
        config: JiraIntegrationConfig | null,
    ): Promise<void> {
        const body = this.buildAdfBody(bodyText);

        const oauth = await getUsableAccessToken('jira', tenantId).catch(() => null);
        if (oauth) {
            const base = (oauth.metadata.apiBaseUrl as string) || '';
            if (base) {
                try {
                    const res = await fetch(`${base}/rest/api/3/issue/${issueKey}/comment`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${oauth.accessToken}`,
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(body),
                    });
                    if (res.ok) return;
                    if (res.status !== 401) {
                        const text = await res.text().catch(() => '');
                        console.error(`[JiraAdapter] Jira OAuth API error ${res.status}: ${text}`);
                        return;
                    }
                    // 401 → token invalid; fall through to manual/env auth
                    console.warn('[JiraAdapter] OAuth token rejected (401) — falling back to manual auth');
                } catch (err) {
                    console.error('[JiraAdapter] OAuth comment post failed, falling back:', err);
                }
            }
        }

        const { baseUrl, userEmail, apiToken } = this.resolveApiConfig(config);
        if (!baseUrl || !userEmail || !apiToken) {
            console.warn('[JiraAdapter] Jira API not configured — skipping comment post');
            return;
        }

        const url = `${baseUrl}/rest/api/3/issue/${issueKey}/comment`;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': this.buildAuthHeader(userEmail, apiToken),
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                console.error(`[JiraAdapter] Jira API error ${res.status}: ${text}`);
            }
        } catch (err) {
            console.error('[JiraAdapter] Failed to post comment:', err);
        }
    }

    // ─── ADF helpers ──────────────────────────────────────────────────

    /**
     * Extract plain text from a Jira comment body (supports ADF and plain string).
     */
    private extractCommentText(comment: JiraWebhookPayload['comment']): string {
        if (!comment?.body) return '';
        if (typeof comment.body === 'string') return comment.body.trim();

        const texts: string[] = [];
        const walk = (nodes: AdfNode[] = []) => {
            for (const node of nodes) {
                if (node.text) texts.push(node.text);
                if (node.content) walk(node.content);
            }
        };
        walk((comment.body as AdfNode).content || []);
        return texts.join('').trim();
    }

    /**
     * Extract plain text from ADF, skipping mention nodes.
     */
    private extractCommentTextWithoutMention(body: AdfNode | string | undefined): string {
        if (!body) return '';
        if (typeof body === 'string') return body.trim();

        const texts: string[] = [];
        const walk = (nodes: AdfNode[] = []) => {
            for (const node of nodes) {
                if (node.type === 'mention') continue;
                if (node.text) texts.push(node.text);
                if (node.content) walk(node.content);
            }
        };
        walk((body as AdfNode).content || []);
        return texts.join('').trim();
    }

    /**
     * Walk ADF nodes and collect mention accountIds.
     */
    private extractMentionAccountIds(body: AdfNode | string | undefined): string[] {
        if (!body || typeof body === 'string') return [];
        const ids: string[] = [];
        const walk = (nodes: AdfNode[] = []) => {
            for (const node of nodes) {
                if (node.type === 'mention' && node.attrs?.id) ids.push(node.attrs.id);
                if (node.content) walk(node.content);
            }
        };
        walk((body as AdfNode).content || []);
        return ids;
    }

    /**
     * Returns true if the comment body contains a mention of the configured bot account.
     */
    private isBotMention(
        comment: JiraWebhookPayload['comment'],
        botAccountId: string | undefined,
    ): boolean {
        if (!botAccountId || !comment?.body) return false;
        const ids = this.extractMentionAccountIds(comment.body as AdfNode);
        return ids.includes(botAccountId);
    }
}

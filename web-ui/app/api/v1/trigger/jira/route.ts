/**
 * Jira Trigger Endpoint
 *
 * POST /api/v1/trigger/jira
 *
 * Handles two payload shapes:
 *   1. Jira Automation rule — custom JSON body, auth via Authorization/x-webhook-secret header
 *   2. Native Jira webhook  — standard `comment_created` event, auth via ?secret= query param
 *
 * Comment routing logic (in priority order):
 *   1. Skip bot's own comments (prevent infinite loops)
 *   2. APPROVE/REJECT on awaiting_approval run → resume or cancel
 *   3. Clarification reply on awaiting_input run → resume with enriched task
 *   4. @bot mention → create new run
 *   5. Automation rule with taskDescription → create new run (existing behaviour)
 */

import { NextResponse } from 'next/server';
import { AuditService } from '@/lib/audit-service';
import {
    verifyJiraSecret,
    extractJiraTaskDescription,
    extractJiraCommentText,
    isBotMention,
    extractCommentTextWithoutMention,
    type JiraWebhookPayload,
} from '@/lib/agent-ops/jira-validator';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun, resumeApprovedRun } from '@/lib/agent-ops/agent-executor';
import { postResultToJira, postErrorToJira, postApprovalResponseToJira } from '@/lib/agent-ops/jira-notifier';
import { TenantConfigService } from '@/lib/tenant-config-service';
import type { JiraTriggerMeta, JiraIntegrationConfig, AgentOpsRun } from '@/lib/agent-ops/types';

export async function POST(req: Request) {
    try {
        // 1. Fetch Jira config from DynamoDB (falls back to env vars)
        let jiraConfig: JiraIntegrationConfig | undefined;
        let webhookSecretOverride: string | undefined;
        try {
            const config = await TenantConfigService.getConfig<JiraIntegrationConfig>('agent-ops-jira');
            if (config) {
                jiraConfig = config;
                webhookSecretOverride = config.webhookSecret;
                if (config.enabled === false) {
                    return NextResponse.json({ error: 'Jira integration is disabled' }, { status: 403 });
                }
            }
        } catch (dbErr) {
            console.warn('[Jira Trigger] Failed to load Jira config from DynamoDB, using env var fallback:', dbErr);
        }

        // 2. Verify auth — header (Automation rules) OR ?secret= query param (native webhooks)
        const url = new URL(req.url);
        const querySecret = url.searchParams.get('secret');
        const authHeader = req.headers.get('authorization') || req.headers.get('x-webhook-secret');

        if (!verifyJiraSecret(authHeader, webhookSecretOverride, querySecret)) {
            console.warn('[Jira Trigger] Authentication failed');
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // 3. Parse JSON payload
        const payload = (await req.json()) as JiraWebhookPayload;

        const issueKey = payload.issue?.key || '';
        const tenantId = payload.issue?.fields?.project?.key || 'default';
        const commentAuthorId = payload.comment?.author?.accountId;

        // 4. Skip bot's own comments (prevent infinite loops)
        if (jiraConfig?.botAccountId && commentAuthorId === jiraConfig.botAccountId) {
            console.log(`[Jira Trigger] Skipping bot's own comment on ${issueKey}`);
            return NextResponse.json({ message: 'Bot comment ignored' });
        }

        // Extract comment text (full, for keyword matching)
        const commentText = extractJiraCommentText(payload.comment);
        const commentKeyword = commentText.trim().toLowerCase();

        // 5. APPROVE/REJECT handling — check before awaiting_input to avoid misrouting
        if (issueKey && (commentKeyword === 'approve' || commentKeyword === 'approved' ||
            commentKeyword === 'reject' || commentKeyword === 'rejected')) {

            const approvalRun = await agentOpsService.findAwaitingApprovalRunByJiraIssue(issueKey);

            if (approvalRun) {
                const isApproved = commentKeyword === 'approve' || commentKeyword === 'approved';
                console.log(`[Jira Trigger] ${isApproved ? 'Approving' : 'Rejecting'} run ${approvalRun.runId} for issue ${issueKey}`);

                if (isApproved) {
                    // Post acknowledgement immediately
                    await postApprovalResponseToJira(true, approvalRun.runId, issueKey, jiraConfig).catch(() => { });

                    // Fire-and-forget resume
                    resumeApprovedRun(approvalRun)
                        .then(async () => {
                            const freshRun = await agentOpsService.getRun(approvalRun.tenantId, approvalRun.runId);
                            await postResultToJira((freshRun || approvalRun) as AgentOpsRun, issueKey, jiraConfig);
                        })
                        .catch((err) => {
                            console.error('[Jira Trigger] Resume execution error:', err);
                            postErrorToJira(err, approvalRun as AgentOpsRun, issueKey, jiraConfig).catch(() => { });
                        });
                } else {
                    await agentOpsService.updateRunStatus(approvalRun.tenantId, approvalRun.runId, 'cancelled');
                    await agentOpsService.recordEvent({
                        runId: approvalRun.runId, eventType: 'final', node: 'approval_gate',
                        content: 'Run rejected by user via Jira comment.',
                    });
                    await postApprovalResponseToJira(false, approvalRun.runId, issueKey, jiraConfig).catch(() => { });
                }

                return NextResponse.json({
                    runId: approvalRun.runId,
                    status: isApproved ? 'in_progress' : 'cancelled',
                    message: isApproved ? `Approved run ${approvalRun.runId}` : `Rejected run ${approvalRun.runId}`,
                });
            }
        }

        // 6. Clarification reply — resume awaiting_input run
        if (issueKey) {
            const awaitingRun = await agentOpsService.findAwaitingRunByJiraIssue(issueKey);

            if (awaitingRun) {
                const userReply = commentText || extractJiraTaskDescription(payload);

                if (userReply && userReply !== 'No task description provided') {
                    console.log(`[Jira Trigger] Resuming awaiting_input run ${awaitingRun.runId} for issue ${issueKey}`);

                    const clarificationContext = awaitingRun.clarification
                        ? `\n\n---\nOriginal clarification question: ${awaitingRun.clarification.question}\nUser reply: ${userReply}`
                        : `\n\n---\nUser clarification: ${userReply}`;

                    const enrichedTask = awaitingRun.taskDescription + clarificationContext;
                    await agentOpsService.updateRunStatus(tenantId, awaitingRun.runId, 'in_progress');

                    const resumedRun = { ...awaitingRun, taskDescription: enrichedTask };
                    executeAgentRun(resumedRun)
                        .then(async () => {
                            const freshRun = await agentOpsService.getRun(tenantId, awaitingRun.runId);
                            await postResultToJira((freshRun as AgentOpsRun) || (resumedRun as AgentOpsRun), issueKey, jiraConfig);
                        })
                        .catch((err) => {
                            console.error('[Jira Trigger] Resume execution error:', err);
                            postErrorToJira(err, resumedRun as AgentOpsRun, issueKey, jiraConfig).catch(() => { });
                        });

                    return NextResponse.json({
                        runId: awaitingRun.runId,
                        status: 'in_progress',
                        message: `Resumed run ${awaitingRun.runId} for issue ${issueKey}`,
                    });
                }
            }
        }

        // 7. Bot mention detection (native webhook / comment_created)
        //    If the comment mentions the bot, extract the task text (without the mention) and create a new run.
        const hasBotMention = jiraConfig?.botAccountId
            ? isBotMention(payload.comment, jiraConfig.botAccountId)
            : false;

        let taskDescription: string;

        if (hasBotMention) {
            // Extract task text with the @mention stripped
            const mentionStripped = extractCommentTextWithoutMention(payload.comment?.body as any);
            if (!mentionStripped) {
                return NextResponse.json({ error: 'No task description found after @mention' }, { status: 400 });
            }
            taskDescription = mentionStripped;
            console.log(`[Jira Trigger] Bot mention detected on ${issueKey}: "${taskDescription}"`);
        } else {
            // Automation rule path — use taskDescription field or issue summary
            taskDescription = extractJiraTaskDescription(payload);
            if (!taskDescription || taskDescription === 'No task description provided') {
                // No bot mention and no task description — ignore (e.g. unrelated comment)
                return NextResponse.json({ message: 'No actionable content found' });
            }
        }

        // 8. Build trigger metadata
        const trigger: JiraTriggerMeta = {
            issueKey,
            projectKey: payload.issue?.fields?.project?.key || '',
            reporter: payload.comment?.author?.displayName || payload.issue?.fields?.reporter?.displayName || '',
            issueType: payload.issue?.fields?.issuetype?.name,
            webhookId: payload.automation?.ruleId,
        };

        const mode = (payload.mode as any) || 'fast';

        // 9. Create a new run record
        const run = await agentOpsService.createRun({
            tenantId,
            source: 'jira',
            taskDescription,
            mode,
            trigger,
            accountId: payload.accountId,
            selectedSkill: payload.selectedSkill,
            autoApprove: jiraConfig?.autoApprove ?? false,
        });

        // Audit: log the incoming Jira trigger
        AuditService.logResourceAction({
            eventType: 'trigger.jira.received',
            severity: 'low',
            apiRoute: 'POST /api/v1/trigger/jira',
            httpMethod: 'POST',
            source: 'external',
            action: 'Received Jira Trigger',
            resourceType: 'trigger',
            resourceId: run.runId,
            resourceName: 'Jira Trigger',
            status: 'success',
            details: `Received Jira trigger for issue ${issueKey || 'unknown'}`,
            userType: 'system',
            metadata: { tenantId, issueKey, projectKey: trigger.projectKey },
        }).catch(() => {});

        // 10. Execute agent asynchronously, then post result/error back to Jira
        executeAgentRun(run)
            .then(async () => {
                if (issueKey) {
                    const freshRun = await agentOpsService.getRun(tenantId, run.runId);
                    await postResultToJira(freshRun || run, issueKey, jiraConfig);
                }
            })
            .catch((err) => {
                console.error('[Jira Trigger] Execution error:', err);
                if (issueKey) postErrorToJira(err, run, issueKey, jiraConfig).catch(() => { });
            });

        return NextResponse.json({
            runId: run.runId,
            status: 'queued',
            message: `Agent Ops run started for issue ${trigger.issueKey}`,
        });

    } catch (error) {
        console.error('[Jira Trigger] Error:', error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : 'Internal server error',
        }, { status: 500 });
    }
}

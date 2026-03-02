/**
 * Jira Trigger Endpoint
 * 
 * POST /api/v1/trigger/jira
 * 
 * Accepts Jira automation rule webhooks,
 * validates the shared secret, creates an agent-ops run,
 * and kicks off the agent asynchronously.
 */

import { NextResponse } from 'next/server';
import { verifyJiraSecret, extractJiraTaskDescription, extractJiraCommentText, type JiraWebhookPayload } from '@/lib/agent-ops/jira-validator';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';
import { postResultToJira, postErrorToJira } from '@/lib/agent-ops/jira-notifier';
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

        // 2. Verify Jira webhook secret
        const authHeader = req.headers.get('authorization') || req.headers.get('x-webhook-secret');
        if (!verifyJiraSecret(authHeader, webhookSecretOverride)) {
            console.warn('[Jira Trigger] Authentication failed');
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // 3. Parse JSON payload
        const payload = (await req.json()) as JiraWebhookPayload;

        // Prefer comment text over issue task description for HIL resume
        const commentText = extractJiraCommentText(payload.comment);
        const taskDescription = extractJiraTaskDescription(payload);

        const issueKey = payload.issue?.key || '';
        const tenantId = payload.issue?.fields?.project?.key || 'default';

        // 4. Check if this is a comment reply to an awaiting_input run for the same issue
        // (Jira comment_created events trigger HIL resume)
        if (issueKey) {
            const awaitingRun = await agentOpsService.findAwaitingRunByJiraIssue(issueKey);

            if (awaitingRun) {
                // Use comment text if available; otherwise fall back to task description
                const userReply = commentText || taskDescription;

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

        // Not a HIL resume — validate and create a new run
        if (!taskDescription || taskDescription === 'No task description provided') {
            return NextResponse.json({
                error: 'Missing task description in payload',
            }, { status: 400 });
        }

        // 5. Build trigger metadata
        const trigger: JiraTriggerMeta = {
            issueKey,
            projectKey: payload.issue?.fields?.project?.key || '',
            reporter: payload.issue?.fields?.reporter?.displayName || '',
            issueType: payload.issue?.fields?.issuetype?.name,
            webhookId: payload.automation?.ruleId,
        };

        // 6. Mode (now handled dynamically by evaluator, but DB needs a string)
        const mode = (payload.mode as any) || 'fast';

        // 7. Create a new run record
        const run = await agentOpsService.createRun({
            tenantId,
            source: 'jira',
            taskDescription,
            mode,
            trigger,
            accountId: payload.accountId,
            selectedSkill: payload.selectedSkill,
        });

        // 8. Execute agent asynchronously, then post result/error back to Jira
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

        // 9. Immediate acknowledgement
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

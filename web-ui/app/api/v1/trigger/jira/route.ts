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
import { verifyJiraSecret, extractJiraTaskDescription, type JiraWebhookPayload } from '@/lib/agent-ops/jira-validator';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';
import { postResultToJira, postErrorToJira } from '@/lib/agent-ops/jira-notifier';
import type { JiraTriggerMeta } from '@/lib/agent-ops/types';

export async function POST(req: Request) {
    try {
        // 1. Verify Jira webhook secret
        const authHeader = req.headers.get('authorization') || req.headers.get('x-webhook-secret');
        if (!verifyJiraSecret(authHeader)) {
            console.warn('[Jira Trigger] Authentication failed');
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // 2. Parse JSON payload
        const payload = (await req.json()) as JiraWebhookPayload;
        const taskDescription = extractJiraTaskDescription(payload);

        if (!taskDescription || taskDescription === 'No task description provided') {
            return NextResponse.json({
                error: 'Missing task description in payload',
            }, { status: 400 });
        }

        // 3. Mode (now handled dynamically by evaluator, but DB needs a string)
        const mode = (payload.mode as any) || 'fast';

        // 4. Build trigger metadata
        const trigger: JiraTriggerMeta = {
            issueKey: payload.issue?.key || '',
            projectKey: payload.issue?.fields?.project?.key || '',
            reporter: payload.issue?.fields?.reporter?.displayName || '',
            issueType: payload.issue?.fields?.issuetype?.name,
            webhookId: payload.automation?.ruleId,
        };

        // 5. Create run record (use project key as tenantId)
        const tenantId = payload.issue?.fields?.project?.key || 'default';
        const run = await agentOpsService.createRun({
            tenantId,
            source: 'jira',
            taskDescription,
            mode,
            trigger,
            accountId: payload.accountId,
            selectedSkill: payload.selectedSkill,
        });

        // 6. Execute agent asynchronously, then post result/error back to Jira
        const issueKey = trigger.issueKey;
        executeAgentRun(run)
            .then(() => issueKey ? postResultToJira(run, issueKey) : undefined)
            .catch((err) => {
                console.error('[Jira Trigger] Execution error:', err);
                if (issueKey) postErrorToJira(err, run, issueKey).catch(() => { });
            });

        // 7. Immediate acknowledgement
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

/**
 * Slack Trigger Endpoint
 * 
 * POST /api/v1/trigger/slack
 * 
 * Accepts Slack slash commands and @mentions,
 * validates the signature, creates an agent-ops run,
 * and kicks off the agent asynchronously.
 */

import { NextResponse } from 'next/server';
import { verifySlackSignature, parseSlackSlashCommand } from '@/lib/agent-ops/slack-validator';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';
import type { SlackTriggerMeta } from '@/lib/agent-ops/types';

export const maxDuration = 10; // Slack requires response < 3s, but allow for processing

export async function POST(req: Request) {
    try {
        // Read raw body for signature verification
        const rawBody = await req.text();
        const timestamp = req.headers.get('x-slack-request-timestamp') || '';
        const signature = req.headers.get('x-slack-signature') || '';

        // 1. Verify Slack signature
        if (!verifySlackSignature(rawBody, timestamp, signature)) {
            console.warn('[Slack Trigger] Signature verification failed');
            return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
        }

        // 2. Parse slash command payload
        const payload = parseSlackSlashCommand(rawBody);
        const taskDescription = payload.text.trim();

        if (!taskDescription) {
            return NextResponse.json({
                response_type: 'ephemeral',
                text: '⚠️ Please provide a task description. Example: `/cloud-ops Check Lambda configurations`',
            });
        }

        // 3. Mode (now handled dynamically by evaluator, but DB needs a string)
        const mode = 'fast';

        // 4. Build trigger metadata
        const trigger: SlackTriggerMeta = {
            userId: payload.user_id,
            userName: payload.user_name,
            channelId: payload.channel_id,
            channelName: payload.channel_name,
            responseUrl: payload.response_url,
            teamId: payload.team_id,
        };

        // 5. Create run record (use team_id as tenantId for multi-tenancy)
        const run = await agentOpsService.createRun({
            tenantId: payload.team_id || 'default',
            source: 'slack',
            taskDescription,
            mode,
            trigger,
        });

        // 6. Execute agent asynchronously (fire-and-forget)
        //    Don't await — respond immediately to Slack
        executeAgentRun(run)
            .then(async () => {
                // Post result back to Slack via response_url
                const updatedRun = await agentOpsService.getRun(run.tenantId, run.runId);
                if (updatedRun?.result?.summary && payload.response_url) {
                    try {
                        await fetch(payload.response_url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                response_type: 'in_channel',
                                text: `✅ *Agent Ops Complete*\n\n*Task:* ${taskDescription}\n*Run ID:* \`${run.runId}\`\n\n${updatedRun.result.summary}`,
                            }),
                        });
                    } catch (postError) {
                        console.error('[Slack Trigger] Failed to post result:', postError);
                    }
                }
            })
            .catch((err) => {
                console.error('[Slack Trigger] Execution error:', err);
                // Best-effort error notification
                if (payload.response_url) {
                    fetch(payload.response_url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            response_type: 'ephemeral',
                            text: `❌ Agent Ops failed: ${err.message}\nRun ID: \`${run.runId}\``,
                        }),
                    }).catch(() => { /* swallow */ });
                }
            });

        // 7. Immediate acknowledgement to Slack (< 3s)
        return NextResponse.json({
            response_type: 'ephemeral',
            text: `🚀 *Agent Ops Started*\n*Task:* ${taskDescription}\n*Mode:* ${mode}\n*Run ID:* \`${run.runId}\`\n\nI'll post the results here when complete.`,
        });

    } catch (error) {
        console.error('[Slack Trigger] Error:', error);
        return NextResponse.json({
            response_type: 'ephemeral',
            text: `❌ Error: ${error instanceof Error ? error.message : 'Internal server error'}`,
        }, { status: 500 });
    }
}

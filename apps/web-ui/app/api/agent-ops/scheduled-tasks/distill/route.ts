/**
 * POST /api/agent-ops/scheduled-tasks/distill — analyze a chat transcript into a
 * self-contained recurring scheduled-task draft (no persistence). Unlike skill
 * distillation, this KEEPS concrete identifiers: the resulting prompt runs
 * unattended on a schedule, with no human to answer clarifying questions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { isProviderConfigError } from '@/lib/agent/provider-errors';

/** Same conservative provider-agnostic backstop used by /api/skills/distill. */
const MAX_TRANSCRIPT_CHARS = 600_000;

/** Fallback cadence when the chat gives no schedule signal. */
const DEFAULT_CRON = '0 9 * * *';

/** A valid 5-field cron expression (minute hour day-of-month month day-of-week). */
function isFiveFieldCron(value: unknown): value is string {
    return typeof value === 'string' && value.trim().split(/\s+/).length === 5;
}

const DISTILL_PROMPT = `You are converting an AI agent's chat transcript into a RECURRING SCHEDULED TASK
— a single, self-contained instruction the same agent will run on a schedule,
UNATTENDED, with NO human available to answer questions.

The transcript may include TOOL_CALL / TOOL_RESULT blocks showing the exact tools,
commands, or API calls the agent used (AWS CLI/SDK, Slack/Jira/other MCP tools,
file operations, knowledge-base lookups, etc.). This platform is not limited to
any one domain — infer the actual domain and tools from the transcript itself; do
not assume AWS or any other specific system.

CRITICAL — this is the OPPOSITE of writing a reusable template:
- KEEP every concrete target from the transcript verbatim: real account IDs,
  regions, resource names/ARNs, numeric thresholds, channel names, ticket
  projects. Do NOT replace them with placeholders — this is one specific job.
- The prompt must be fully standalone: assume fresh context on every run. Never
  refer to "the previous chat", "as we discussed", or the user. Never ask a
  clarifying question — decide and act.

Return ONLY a JSON object (no markdown fences) with keys:
- "name": short Title Case name for the recurring job (max 6 words).
- "prompt": the standalone run instruction. It MUST:
  1. Open with the recurring objective in one line ("Every run, ...").
  2. Give the exact ordered steps, naming the REAL tools/commands/API calls used
     in the transcript (grounded in the actual TOOL_CALL blocks), with the
     concrete targets retained.
  3. End with the deliverable: what to check/compute and exactly what to include
     in the run summary each time.
- "suggestedCron": a 5-field cron expression inferred from the chat's intent
  (e.g. a daily audit -> "0 9 * * *"). If the chat gives no cadence signal, use
  "${DEFAULT_CRON}".
- "cadenceLabel": a short human label for that cadence (e.g. "Daily at 9:00 AM").

Transcript:
`;

export async function POST(request: NextRequest) {
    const authError = await authorize('create', 'Agent');
    if (authError) return authError;
    try {
        const tenantId = await getSessionTenantId();
        const body = await request.json();
        const { transcript } = body;
        if (!transcript || typeof transcript !== 'string') {
            return NextResponse.json(
                { success: false, error: 'Missing transcript' },
                { status: 400 }
            );
        }
        if (transcript.length > MAX_TRANSCRIPT_CHARS) {
            return NextResponse.json(
                {
                    success: false,
                    error: `This conversation is too long to convert in a single pass (~${Math.round(transcript.length / 1000)}k chars, limit ~${Math.round(MAX_TRANSCRIPT_CHARS / 1000)}k). Try a shorter portion of the chat, or configure a larger-context model as your tenant default.`,
                },
                { status: 413 }
            );
        }
        const modelConfig = await resolveDefaultModelConfig(tenantId);
        const { main } = createAgentModels(modelConfig);
        const resp = await main.invoke(`${DISTILL_PROMPT}\n${transcript}`);
        const raw = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        const jsonText = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        let draft: { name?: string; prompt?: string; suggestedCron?: string; cadenceLabel?: string };
        try {
            draft = JSON.parse(jsonText);
        } catch {
            return NextResponse.json(
                { success: false, error: 'Model did not return valid JSON' },
                { status: 502 }
            );
        }
        const suggestedCron = isFiveFieldCron(draft.suggestedCron) ? draft.suggestedCron.trim() : DEFAULT_CRON;
        return NextResponse.json({
            success: true,
            data: {
                name: draft.name ?? 'Untitled Scheduled Task',
                prompt: draft.prompt ?? '',
                suggestedCron,
                cadenceLabel: draft.cadenceLabel ?? 'Daily at 9:00 AM',
            },
        });
    } catch (error) {
        if (isProviderConfigError(error)) {
            return NextResponse.json(
                { success: false, error: (error as Error).message },
                { status: 400 }
            );
        }
        console.error('[ScheduledTasksAPI] distill error:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to convert' },
            { status: 500 }
        );
    }
}

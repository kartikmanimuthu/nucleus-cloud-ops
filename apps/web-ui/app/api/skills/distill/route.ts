/**
 * POST /api/skills/distill — distil a chat transcript into a reusable skill draft (no persistence)
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { isProviderConfigError } from '@/lib/agent/provider-errors';
import { contentToText, extractJsonObject } from '@/lib/agent/llm-json';

/**
 * No per-model context-window figure is tracked anywhere in this codebase (the
 * `maxTokens` field on provider records is the output completion cap, not input
 * size). This is a conservative, provider-agnostic backstop against pathological
 * input (~150k tokens at ~4 chars/token) — comfortably under mainstream
 * 128k-200k-token context windows — not a routine limiter.
 */
const MAX_TRANSCRIPT_CHARS = 600_000;

const DISTILL_PROMPT = `You are distilling an AI agent's chat transcript into a reusable "skill" — a
generalized procedure the same agent can follow again for similar future requests.

The transcript may include TOOL_CALL / TOOL_RESULT blocks showing the exact
tools, commands, or API calls the agent actually used (AWS CLI, AWS SDK calls,
Slack/Jira/other MCP tool calls, file operations, etc.) — this platform is not
limited to any one domain. Infer the actual domain and tools from the
transcript itself; do not assume AWS or any other specific system.

Return ONLY a JSON object (no markdown fences) with keys:
- "name": short Title Case name (max 5 words)
- "description": one sentence describing when to use this skill
- "tier": one of "read-only" | "mutation" | "approval-gated" — pick based on
  what the actual tool calls did:
  - "read-only": every tool call only queried/read/listed state, nothing was
    changed anywhere
  - "mutation": at least one tool call created, updated, deleted, sent, or
    posted something in any external system (cloud resources, tickets,
    messages, files, etc.)
  - "approval-gated": the transcript shows a destructive/irreversible action,
    or the agent explicitly asked for human confirmation before proceeding
- "content": a markdown SKILL body with a one-line intro and a numbered,
  generalized step-by-step procedure GROUNDED in the actual tool calls made
  (name the real commands/API calls/tool names used, not generic UI
  navigation). Strip one-off identifiers (specific account/resource IDs,
  ticket numbers, usernames) and replace with placeholders — describe the
  repeatable method, not the one-off answer.

Transcript:
`;

export async function POST(request: NextRequest) {
    const authError = await authorize('create', 'Skill');
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
                    error: `This conversation is too long to distill in a single pass (~${Math.round(transcript.length / 1000)}k chars, limit ~${Math.round(MAX_TRANSCRIPT_CHARS / 1000)}k). Try a shorter portion of the chat, or configure a larger-context model as your tenant default.`,
                },
                { status: 413 }
            );
        }
        const modelConfig = await resolveDefaultModelConfig(tenantId);
        const { main } = createAgentModels(modelConfig);
        const resp = await main.invoke(`${DISTILL_PROMPT}\n${transcript}`);
        const raw = contentToText(resp.content);
        const draft = extractJsonObject<{ name?: string; description?: string; tier?: string; content?: string }>(raw);
        if (!draft) {
            console.error('[SkillsAPI] distill: model reply was not parseable JSON:', raw.slice(0, 500));
            return NextResponse.json(
                { success: false, error: 'Model did not return valid JSON' },
                { status: 502 }
            );
        }
        const validTiers = ['read-only', 'mutation', 'approval-gated'];
        const tier = validTiers.includes(draft.tier ?? '') ? draft.tier : 'read-only';
        return NextResponse.json({
            success: true,
            data: {
                name: draft.name ?? 'Untitled Skill',
                description: draft.description ?? '',
                tier,
                content: draft.content ?? '',
            },
        });
    } catch (error) {
        if (isProviderConfigError(error)) {
            return NextResponse.json(
                { success: false, error: (error as Error).message },
                { status: 400 }
            );
        }
        console.error('[SkillsAPI] distill error:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to distill' },
            { status: 500 }
        );
    }
}

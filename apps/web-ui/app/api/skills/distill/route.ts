/**
 * POST /api/skills/distill — distil a chat transcript into a reusable skill draft (no persistence)
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { isProviderConfigError } from '@/lib/agent/provider-errors';

const DISTILL_PROMPT = `You are distilling a CloudOps chat transcript into a reusable agent "skill".
Return ONLY a JSON object (no markdown fences) with keys:
- "name": short Title Case name (max 5 words)
- "description": one sentence describing when to use this skill
- "tier": one of "read-only" | "mutation" | "approval-gated" (pick based on whether the procedure only reads, or also creates/updates/deletes resources)
- "content": a markdown SKILL body with a one-line intro and a numbered, generalized step-by-step procedure (strip account-specific IDs; describe the repeatable method, not the one-off answer).

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
        const modelConfig = await resolveDefaultModelConfig(tenantId);
        const { main } = createAgentModels(modelConfig);
        const resp = await main.invoke(`${DISTILL_PROMPT}\n${transcript.slice(0, 24000)}`);
        const raw = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        const jsonText = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        let draft: { name?: string; description?: string; tier?: string; content?: string };
        try {
            draft = JSON.parse(jsonText);
        } catch {
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

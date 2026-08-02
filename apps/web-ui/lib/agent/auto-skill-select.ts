/**
 * auto-skill-select.ts — Hermes-style progressive disclosure for chat.
 * When the user hasn't picked a skill, one cheap reflector-model call matches
 * the message against the tenant's skill catalog and picks a slug (or none).
 * Manual selection always wins; this runs only for unselected messages.
 * Never throws.
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { contentToText, type ResolvedModelConfig } from './agent-shared';
import { createAgentModels } from './model-factory';
import { getSkillSummaries, getSkillById } from '@/lib/skill-service';

export async function autoSelectSkill(params: {
    tenantId: string;
    message: string;
    model: ResolvedModelConfig;
}): Promise<{ slug: string; reasoning: string } | null> {
    try {
        const catalog = await getSkillSummaries(params.tenantId);
        if (catalog.startsWith('No specialized skills')) return null;

        const { reflector } = createAgentModels(params.model);
        const sys = new SystemMessage(
            `You select the single most relevant skill for a user request, or none.\n\n${catalog}\n\n` +
            `Return ONLY a JSON object: {"skillId": "<slug>" | null, "reasoning": "<one short line>"}\n` +
            `Rules: selecting a skill is the DEFAULT. Match on the request's domain (cost, EC2, Jira, security, …), not exact wording — a skill whose description covers the task's subject area is a match. Return null ONLY when nothing in the catalog is even loosely related.`,
        );
        const resp = await reflector.invoke([sys, new HumanMessage(params.message.slice(0, 4000))]);
        const content = contentToText(resp.content);
        const match = content.match(/\{[\s\S]*\}/);
        if (!match) return null;
        const parsed = JSON.parse(match[0]) as { skillId?: string | null; reasoning?: string };
        if (!parsed.skillId) {
            console.log('🎯 [SKILL AUTO-SELECT] No skill matched — agent runs with the skill catalog only');
            return null;
        }
        // The catalog lists ENABLED skills only — membership rejects disabled or
        // hallucinated slugs before the per-tenant existence check.
        if (!catalog.includes(`- ${parsed.skillId}:`)) {
            console.warn(`🎯 [SKILL AUTO-SELECT] Model returned skill '${parsed.skillId}' not in the enabled catalog — ignoring`);
            return null;
        }
        const skill = await getSkillById(params.tenantId, parsed.skillId);
        if (!skill) {
            console.warn(`🎯 [SKILL AUTO-SELECT] Model returned unknown skill '${parsed.skillId}' — ignoring`);
            return null;
        }
        console.log(`🎯 [SKILL AUTO-SELECT] Matched '${parsed.skillId}' — ${parsed.reasoning ?? '(no reasoning)'}`);
        return { slug: parsed.skillId, reasoning: parsed.reasoning ?? '' };
    } catch (err: any) {
        console.warn(`🎯 [SKILL AUTO-SELECT] Failed (non-fatal): ${err?.message ?? err}`);
        return null;
    }
}

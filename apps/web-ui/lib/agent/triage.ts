/**
 * triage.ts — chat-layer routing in front of the agent workflow.
 *
 * One cheap reflector-model call classifies the incoming message:
 *   - 'direct': conversational (greeting/thanks/capability question/answerable
 *     from the visible conversation) → the chat route replies with a single
 *     plain LLM call — no memory recall, no planner, no plan rail, no tools.
 *   - 'task':   everything else → the normal agent workflow.
 *
 * The same call doubles as the skill auto-selector (Hermes disclosure), so
 * adding the chat layer costs ZERO net new LLM calls per message — it replaces
 * the previous standalone autoSelectSkill call.
 *
 * Fail-open: any error, parse failure, or disabled flag routes to 'task'
 * (a wasted planner pass is cheaper than a wrong "I can't do that" reply).
 * Kill-switch: CHAT_TRIAGE_ENABLED=false reverts routing to always-'task'
 * while keeping skill auto-selection (via the legacy autoSelectSkill path).
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { contentToText, type ResolvedModelConfig } from './agent-shared';
import { createAgentModels } from './model-factory';
import { getSkillSummaries, getSkillById } from '@/lib/skill-service';
import { autoSelectSkill } from './auto-skill-select';

export function chatTriageEnabled(): boolean {
    const v = process.env.CHAT_TRIAGE_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

export interface TriageResult {
    route: 'direct' | 'task';
    skillId: string | null;
    reasoning: string;
}

const TASK_FALLBACK: TriageResult = { route: 'task', skillId: null, reasoning: 'fallback' };

/**
 * Pure parser for the triage model's JSON reply. Exported for unit tests.
 * Unknown/malformed input fails open to 'task'. skillId membership in the
 * catalog is checked here; per-tenant existence is re-verified by the caller.
 */
export function parseTriageResponse(content: string, catalog: string | null): TriageResult {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return TASK_FALLBACK;
    try {
        const parsed = JSON.parse(match[0]) as { route?: string; skillId?: string | null; reasoning?: string };
        const route = parsed.route === 'direct' ? 'direct' : 'task';
        let skillId: string | null = typeof parsed.skillId === 'string' && parsed.skillId ? parsed.skillId : null;
        // The catalog lists ENABLED skills only — membership rejects disabled or
        // hallucinated slugs (same guard as auto-skill-select).
        if (skillId && (!catalog || !catalog.includes(`- ${skillId}:`))) skillId = null;
        return { route, skillId, reasoning: parsed.reasoning ?? '' };
    } catch {
        return TASK_FALLBACK;
    }
}

export async function triageChatMessage(params: {
    tenantId: string;
    message: string;
    model: ResolvedModelConfig;
    /** True when the user manually pinned a skill — skill matching is skipped. */
    skillAlreadySelected?: boolean;
}): Promise<TriageResult> {
    // Kill-switch: preserve pre-triage behavior exactly (always workflow,
    // legacy standalone skill auto-selection).
    if (!chatTriageEnabled()) {
        if (params.skillAlreadySelected) return TASK_FALLBACK;
        const auto = await autoSelectSkill({ tenantId: params.tenantId, message: params.message, model: params.model });
        return { route: 'task', skillId: auto?.slug ?? null, reasoning: auto?.reasoning ?? 'triage disabled' };
    }

    try {
        const catalog = params.skillAlreadySelected
            ? null
            : await getSkillSummaries(params.tenantId)
                .then(s => (s.startsWith('No specialized skills') ? null : s))
                .catch(() => null);

        const skillInstruction = catalog
            ? `\n${catalog}\n\nFor "task" routes, also pick the single most relevant skill from the catalog above — or null when none clearly matches its description. For "direct" routes, skillId is always null.`
            : `\nskillId is always null.`;

        const sys = new SystemMessage(
            `You route an incoming message for a DevOps/cloud-operations AI agent.\n\n` +
            `Classify the message as:\n` +
            `- "direct" ONLY when it is: a greeting, thanks, farewell, or small talk; a question about what the assistant can do; or fully answerable from the conversation itself with NO tools, NO AWS/data lookups, and NO actions.\n` +
            `- "task" for EVERYTHING else — any request that mentions or implies infrastructure, resources, accounts, costs, incidents, logs, files, schedules, reports, or any action or investigation.\n` +
            `When in doubt, choose "task".\n` +
            skillInstruction +
            `\n\nReturn ONLY a JSON object: {"route": "direct" | "task", "skillId": "<slug>" | null, "reasoning": "<one short line>"}`,
        );

        const { reflector } = createAgentModels(params.model);
        const resp = await reflector.invoke([sys, new HumanMessage(params.message.slice(0, 4000))]);
        const result = parseTriageResponse(contentToText(resp.content), catalog);

        // Re-verify the slug against the tenant DB (mirrors auto-skill-select).
        if (result.skillId) {
            const skill = await getSkillById(params.tenantId, result.skillId).catch(() => null);
            if (!skill) {
                console.warn(`🚦 [TRIAGE] Model returned unknown skill '${result.skillId}' — ignoring`);
                result.skillId = null;
            }
        }

        console.log(`🚦 [TRIAGE] route=${result.route}${result.skillId ? ` skill=${result.skillId}` : ''} — ${result.reasoning || '(no reasoning)'}`);
        return result;
    } catch (err: any) {
        console.warn(`🚦 [TRIAGE] Failed (non-fatal, routing to task): ${err?.message ?? err}`);
        return TASK_FALLBACK;
    }
}

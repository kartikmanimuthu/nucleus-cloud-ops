/**
 * auto-kb-select.ts — progressive disclosure for knowledge bases, mirroring
 * auto-skill-select.ts. When the user picked no KB, one cheap reflector call
 * matches the message against the tenant's KB catalog and returns the relevant
 * KB ids (zero, one, or many). Manual selection always wins; never throws.
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { contentToText, type ResolvedModelConfig } from './agent-shared';
import { createAgentModels } from './model-factory';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';

export function autoKbSelectionEnabled(): boolean {
    const v = process.env.AUTO_KB_SELECTION_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

/**
 * The model is asked for JSON but does not always oblige exactly: it may fence the
 * block, or add prose containing braces, in which case a greedy first-to-last-brace
 * match spans text that will not parse. Try the greedy span, then the first object.
 */
function parseSelection(text: string): { kbIds?: unknown; reasoning?: string } | null {
    const cleaned = text.replace(/```(?:json)?/gi, '');
    const candidates = [cleaned.match(/\{[\s\S]*\}/)?.[0], cleaned.match(/\{[\s\S]*?\}/)?.[0]];
    for (const candidate of candidates) {
        if (!candidate) continue;
        try { return JSON.parse(candidate) as { kbIds?: unknown; reasoning?: string }; } catch { /* try the next shape */ }
    }
    return null;
}

export async function autoSelectKb(params: {
    tenantId: string;
    message: string;
    model: ResolvedModelConfig;
}): Promise<{ kbIds: string[]; reasoning: string }> {
    const empty = { kbIds: [] as string[], reasoning: '' };
    if (!autoKbSelectionEnabled()) return empty;
    // A resume turn carries a Command, not user text, so there is nothing to match on.
    // Calling the model with an empty HumanMessage throws ("'human' must contain
    // non-empty content") — caught below, but it meant every resume turn logged a
    // failure and silently skipped KB selection.
    if (!params.message.trim()) return empty;
    try {
        const kbs = await KnowledgeBaseService.listKnowledgeBases(params.tenantId);
        // Only active KBs with at least one embedded vector are auto-selectable.
        const active = kbs.filter((k) => k.status === 'active' && (k.vectorCount ?? 0) > 0);
        if (active.length === 0) return empty;

        const catalog = active.map((k) => `- ${k.id}: ${k.name}${k.description ? ` — ${k.description}` : ''}`).join('\n');
        const validIds = new Set(active.map((k) => k.id));

        const { reflector } = createAgentModels(params.model);
        const sys = new SystemMessage(
            `You select which knowledge bases (if any) are relevant to a user request.\n\n` +
            `Available knowledge bases:\n${catalog}\n\n` +
            `Return ONLY a JSON object: {"kbIds": ["<id>", ...], "reasoning": "<one short line>"}\n` +
            `Rules: include a KB id ONLY when its description clearly matches the request. Pick multiple if several are relevant. Return an empty array when none clearly apply.`,
        );
        const resp = await reflector.invoke([sys, new HumanMessage(params.message.slice(0, 4000))]);
        const parsed = parseSelection(contentToText(resp.content));
        if (!parsed) return empty;
        const ids = Array.isArray(parsed.kbIds)
            ? parsed.kbIds.filter((id): id is string => typeof id === 'string' && validIds.has(id))
            : [];
        if (ids.length > 0) {
            console.log(`🎯 [KB AUTO-SELECT] Matched [${ids.join(', ')}] — ${parsed.reasoning ?? '(no reasoning)'}`);
        }
        return { kbIds: ids, reasoning: parsed.reasoning ?? '' };
    } catch (err: any) {
        console.warn(`🎯 [KB AUTO-SELECT] Failed (non-fatal): ${err?.message ?? err}`);
        return empty;
    }
}

/** Manual selection wins; otherwise auto-select. Returns the effective KB ids. */
export async function resolveKnowledgeBaseIds(params: {
    tenantId: string; selectedIds?: string[] | null; message: string; model: ResolvedModelConfig;
}): Promise<string[]> {
    if (params.selectedIds && params.selectedIds.length > 0) return params.selectedIds;
    const { kbIds } = await autoSelectKb({ tenantId: params.tenantId, message: params.message, model: params.model });
    return kbIds;
}

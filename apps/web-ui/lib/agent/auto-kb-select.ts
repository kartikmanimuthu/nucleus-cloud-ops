/**
 * auto-kb-select.ts — progressive disclosure for knowledge bases, mirroring
 * auto-skill-select.ts. When the user picked no KB, one cheap reflector call
 * matches the message against the tenant's KB catalog and returns the relevant
 * KB ids (zero, one, or many). Manual selection always wins; never throws.
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { ResolvedModelConfig } from './agent-shared';
import { createAgentModels } from './model-factory';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';

export function autoKbSelectionEnabled(): boolean {
    const v = process.env.AUTO_KB_SELECTION_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

export async function autoSelectKb(params: {
    tenantId: string;
    message: string;
    model: ResolvedModelConfig;
}): Promise<{ kbIds: string[]; reasoning: string }> {
    const empty = { kbIds: [] as string[], reasoning: '' };
    if (!autoKbSelectionEnabled()) return empty;
    try {
        const kbs = await KnowledgeBaseService.listKnowledgeBases(params.tenantId);
        // vectorCount is a required field in production (defaults to 0 for a KB with
        // no synced documents yet); only exclude KBs explicitly known to have zero
        // vectors, treating an absent value (e.g. lightweight test doubles) as active.
        const active = kbs.filter((k) => k.vectorCount === undefined || k.vectorCount > 0);
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
        const content = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        const match = content.match(/\{[\s\S]*\}/);
        if (!match) return empty;
        const parsed = JSON.parse(match[0]) as { kbIds?: unknown; reasoning?: string };
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

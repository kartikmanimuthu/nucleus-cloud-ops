/**
 * reconcile.ts — save-time semantic conflict resolution (Phase 2).
 *
 * extract → neighbor fetch (pgvector) → one batched LLM judge call →
 * apply (ADD / UPDATE / SUPERSEDE / REINFORCE / NOOP) via MemoryService.
 * Policy layer only — MemoryService stays a pure data layer.
 * Never throws; every failure degrades to ADD (legacy behavior).
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { contentToText } from '../agent-shared';
import { getMemoryService } from './memory-service';
import type { ExtractedFact, MemoryHit, ReconcileDecision, ReconcileSummary } from './types';

export const RECONCILE_TOP_K = 5;
// Cosine distance (0 = identical). Neighbors farther than this are treated as
// unrelated and the fact goes straight to ADD. Initial guess — tune from logs.
export const RECONCILE_DISTANCE_THRESHOLD = 0.55;

export function reconcileEnabled(): boolean {
    const v = process.env.MEMORY_RECONCILE_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

interface FactWithNeighbors {
    factIndex: number;
    fact: ExtractedFact;
    neighbors: MemoryHit[];
}

const JUDGE_SYSTEM = new SystemMessage(
    `You reconcile newly extracted agent memories against similar existing memories.
For each new fact, choose exactly one action:
- "ADD": genuinely new information not covered by any neighbor.
- "UPDATE": same fact as one neighbor but with more or refined detail. Provide "mergedValue": the neighbor's value enriched with the new detail (same JSON shape as the new fact's value).
- "SUPERSEDE": the new fact EXPLICITLY CONTRADICTS one neighbor — both cannot be true (e.g. a resource moved region). The new fact wins. Provide "targetId".
- "REINFORCE": semantically the same fact as one neighbor; nothing new. Provide "targetId".
- "NOOP": ephemeral or not worth remembering.
Items may be facts or operating rules; the same actions apply (a rule that changed = SUPERSEDE; the same rule re-learned = REINFORCE).
Rules:
- SUPERSEDE only on mutual exclusivity, NEVER on similarity or partial overlap.
- Uncertain between UPDATE and REINFORCE → choose REINFORCE.
- Uncertain whether facts contradict → choose ADD (keep both).
Return ONLY a JSON array with one object per fact:
[{"factIndex": 0, "action": "SUPERSEDE", "targetId": "..."}]
"targetId" must be an id from that fact's own neighbors. Include "mergedValue" only for UPDATE.`,
);

function parseDecisions(content: string): ReconcileDecision[] {
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed) ? (parsed as ReconcileDecision[]) : [];
    } catch {
        return [];
    }
}

function isValidDecision(d: ReconcileDecision, item: FactWithNeighbors): boolean {
    const neighborIds = new Set(item.neighbors.map((n) => n.id));
    switch (d.action) {
        case 'ADD':
        case 'NOOP':
            return true;
        case 'REINFORCE':
        case 'SUPERSEDE':
            return !!d.targetId && neighborIds.has(d.targetId);
        case 'UPDATE':
            return !!d.targetId && neighborIds.has(d.targetId)
                && !!d.mergedValue && typeof d.mergedValue === 'object' && !Array.isArray(d.mergedValue);
        default:
            return false;
    }
}

export async function reconcileMemories(params: {
    tenantId: string;
    userId: string;
    facts: ExtractedFact[];
    judgeModel: BaseChatModel;
    sourceThreadId?: string;
}): Promise<ReconcileSummary> {
    const { tenantId, userId, facts, judgeModel, sourceThreadId } = params;
    const summary: ReconcileSummary = { added: 0, updated: 0, superseded: 0, reinforced: 0, noop: 0, failed: 0 };
    const svc = getMemoryService();

    const add = async (fact: ExtractedFact): Promise<void> => {
        await svc.remember({
            tenantId, userId, kind: fact.kind ?? 'SEMANTIC',
            namespace: fact.namespace, key: fact.key,
            value: fact.value as unknown as Record<string, unknown>,
            sourceThreadId,
        });
        summary.added++;
    };

    // 1. Neighbor fetch — facts with no near neighbor skip the judge entirely.
    const withNeighbors: FactWithNeighbors[] = [];
    for (const [factIndex, fact] of facts.entries()) {
        let neighbors: MemoryHit[] = [];
        try {
            // Query by the value JSON — the same text remember() embeds, so distances are comparable.
            const hits = await svc.recall({
                tenantId, userId, query: JSON.stringify(fact.value),
                kinds: [fact.kind ?? 'SEMANTIC'], limit: RECONCILE_TOP_K,
            });
            neighbors = hits.filter((h) => h.distance !== undefined && h.distance <= RECONCILE_DISTANCE_THRESHOLD);
        } catch {
            // recall failure → treat as no neighbors
        }
        if (neighbors.length === 0) {
            try {
                console.log(`🧠 [JUDGE] ${fact.key}: ADD (no near neighbors)`);
                await add(fact);
            } catch (err: any) {
                console.warn(`[Reconcile] ADD failed for ${fact.key}: ${err?.message ?? err}`);
                summary.failed++;
            }
        } else {
            console.log(`🧠 [JUDGE] ${fact.key}: ${neighbors.length} neighbor(s) — ${neighbors.map(n => `${n.key}(d=${n.distance?.toFixed(2)})`).join(', ')}`);
            withNeighbors.push({ factIndex, fact, neighbors });
        }
    }
    if (withNeighbors.length === 0) return summary;

    // 2. One batched judge call for every fact that has neighbors.
    const decisions = new Map<number, ReconcileDecision>();
    try {
        const input = new HumanMessage(JSON.stringify(
            withNeighbors.map((w) => ({
                factIndex: w.factIndex,
                newFact: { namespace: w.fact.namespace.join('/'), key: w.fact.key, value: w.fact.value },
                neighbors: w.neighbors.map((n) => ({ id: n.id, namespace: n.namespace, key: n.key, value: n.value })),
            })), null, 2,
        ));
        const resp = await judgeModel.invoke([JUDGE_SYSTEM, input]);
        const content = contentToText(resp.content);
        for (const d of parseDecisions(content)) {
            if (typeof d?.factIndex === 'number') decisions.set(d.factIndex, d);
        }
    } catch (err: any) {
        console.warn(`[Reconcile] Judge failed, falling back to ADD: ${err?.message ?? err}`);
        // decisions stays empty → every fact falls back to ADD below
    }

    // 3. Apply — anything missing/invalid degrades to ADD; one failure never blocks siblings.
    for (const item of withNeighbors) {
        const d = decisions.get(item.factIndex);
        try {
            if (!d || !isValidDecision(d, item)) {
                console.log(`🧠 [JUDGE] ${item.fact.key}: ADD (fallback — ${!d ? 'no decision returned' : 'invalid decision'})`);
                await add(item.fact);
                continue;
            }
            switch (d.action) {
                case 'ADD':
                    console.log(`🧠 [JUDGE] ${item.fact.key}: ADD (novel despite neighbors)`);
                    await add(item.fact);
                    break;
                case 'UPDATE':
                    console.log(`🧠 [JUDGE] ${item.fact.key}: UPDATE → ${d.targetId}`);
                    await svc.update(tenantId, d.targetId!, d.mergedValue!);
                    summary.updated++;
                    break;
                case 'SUPERSEDE': {
                    console.log(`🧠 [JUDGE] ${item.fact.key}: SUPERSEDE → displacing ${d.targetId}`);
                    const newId = await svc.remember({
                        tenantId, userId, kind: item.fact.kind ?? 'SEMANTIC',
                        namespace: item.fact.namespace, key: item.fact.key,
                        value: item.fact.value as unknown as Record<string, unknown>,
                        sourceThreadId,
                    });
                    if (newId !== d.targetId!) {
                        await svc.supersede(tenantId, d.targetId!, newId);
                        summary.superseded++;
                        summary.added++;
                    } else {
                        // remember() upserted ONTO the very row the judge wanted superseded
                        // (they share namespace+key — the "same fact, value changed" case).
                        // The ON CONFLICT DO UPDATE already replaced the value in place, so the
                        // fact is current. Calling supersede() here would set the row's
                        // supersededById to itself and recall's `supersededById IS NULL` filter
                        // would drop it — data loss. In-place update is the correct outcome.
                        console.log(`🧠 [JUDGE] ${item.fact.key}: SUPERSEDE collapsed to in-place update (new row == target ${d.targetId})`);
                        summary.updated++;
                    }
                    break;
                }
                case 'REINFORCE':
                    console.log(`🧠 [JUDGE] ${item.fact.key}: REINFORCE → ${d.targetId} (TTL refreshed)`);
                    await svc.reinforce(tenantId, d.targetId!);
                    summary.reinforced++;
                    break;
                case 'NOOP':
                    console.log(`🧠 [JUDGE] ${item.fact.key}: NOOP (dropped)`);
                    summary.noop++;
                    break;
            }
        } catch (err: any) {
            console.warn(`[Reconcile] Apply failed for ${item.fact.key}: ${err?.message ?? err}`);
            summary.failed++;
        }
    }

    return summary;
}

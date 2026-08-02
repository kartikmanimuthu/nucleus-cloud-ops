/**
 * memory-nodes.ts
 *
 * Shared memory_recall and memory_save graph nodes for all agent types.
 * memory_recall: semantic search + LLM relevance filter before task execution.
 * memory_save: LLM extraction of learnings after task completion.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { truncateOutput, contentToText } from "./agent-shared";
import { saveMemory } from "./persistence";
import { getMemoryService } from "./memory/memory-service";
import { memoryLogVerbose } from "./memory/log";
import {
    captureEpisode, episodicMemoryEnabled, formatEpisodesSection, composeMemoryContext,
    EPISODE_RECALL_LIMIT, EPISODE_DISTANCE_THRESHOLD,
} from "./memory/episode";
import { reconcileMemories, reconcileEnabled } from "./memory/reconcile";
import {
    proceduralMemoryEnabled, formatProceduresSection, isValidExtractedItem,
    PROCEDURE_RECALL_LIMIT, PROCEDURE_DISTANCE_THRESHOLD,
} from "./memory/procedural";
import { synthesizeDomainSkills } from "./memory/skill-synthesis";
import type {
    ExtractedFact, EpisodicValue, ProceduralValue, MemoryNodeState,
    MemoryRecallStats, MemorySaveStats, MemoryHitStat,
} from "./memory/types";

interface MemoryNodeDeps {
    reflectorModel: BaseChatModel;
    tenantId?: string;
    userId?: string;
    store: unknown | null;
}

export function createMemoryRecallNode(deps: MemoryNodeDeps) {
    const { reflectorModel, tenantId, userId, store } = deps;

    return async function memoryRecallNode(state: MemoryNodeState): Promise<{ memoryContext: string; memoryStats: MemoryRecallStats | null }> {
        if (!store || !tenantId || !userId) {
            console.log("[MemoryRecall] Skipped — store, tenantId, or userId not available");
            return { memoryContext: "", memoryStats: null };
        }

        const { messages } = state;
        const lastHuman = [...messages].reverse().find(m => m._getType() === "human");
        if (!lastHuman) {
            console.log("[MemoryRecall] Skipped — no human message found");
            return { memoryContext: "", memoryStats: null };
        }

        const query = contentToText(lastHuman.content);

        console.log(`\n🧠 [MEMORY RECALL] Searching memories for: "${truncateOutput(query, 100)}"`);

        const factStats: MemoryHitStat[] = [];
        const ruleStats: MemoryHitStat[] = [];
        const episodeStats: MemoryHitStat[] = [];

        // ── Semantic facts → existing LLM relevance filter ──────────────────
        let factsSection = "";
        try {
            const hits = await getMemoryService().recall({
                tenantId, userId, query, kinds: ["SEMANTIC"], limit: 10,
            });
            console.log(`🧠 [RECALL:facts] ${hits.length} hit(s): ${hits.map(h => `${h.key}${h.distance !== undefined ? `(d=${h.distance.toFixed(2)})` : ''}`).join(', ') || '(none)'}`);
            hits.forEach(h => factStats.push({ key: h.key, distance: h.distance }));
            if (hits.length > 0) {
                const memorySummary = hits.map((m, i) =>
                    `${i + 1}. [${m.namespace}/${m.key}] ${JSON.stringify(m.value)}`
                ).join("\n");
                try {
                    const filterPrompt = new SystemMessage(
                        `You are a relevance filter. Given a user task and a list of memories from previous sessions, return ONLY the memories that are directly relevant to the current task.

Return a markdown list of relevant memories, each on its own line with the format:
- [namespace/key] One-line summary of the relevant fact

If no memories are relevant, return exactly: NONE`
                    );
                    const filterInput = new HumanMessage({
                        content: `**User Task:** ${truncateOutput(query, 2000)}

**Available Memories:**
${memorySummary}

Return only the relevant memories.`
                    });
                    const response = await reflectorModel.invoke([filterPrompt, filterInput]);
                    const content = contentToText(response.content);
                    factsSection = (content.trim() === "NONE") ? "" : content.trim();
                    console.log(`🧠 [RECALL:facts] LLM filter ${factsSection ? `kept:\n${factsSection}` : 'kept none (NONE)'}`);
                } catch (err: any) {
                    console.warn(`[MemoryRecall] Relevance filter failed: ${err?.message ?? err}`);
                    factsSection = hits.slice(0, 5).map(m =>
                        `- [${m.namespace}/${m.key}] ${JSON.stringify(m.value)}`
                    ).join("\n");
                }
            }
        } catch (err: any) {
            console.warn(`[MemoryRecall] Semantic search failed: ${err?.message ?? err}`);
        }

        // ── Learned operating rules — distance-gated, no LLM filter ─────────
        let proceduresSection = "";
        if (proceduralMemoryEnabled(tenantId)) {
            try {
                const rules = await getMemoryService().recall({
                    tenantId, userId, query, kinds: ["PROCEDURAL"], limit: PROCEDURE_RECALL_LIMIT,
                });
                rules.forEach(r => {
                    const d = r.distance;
                    const kept = d !== undefined && d <= PROCEDURE_DISTANCE_THRESHOLD;
                    console.log(`🧠 [RECALL:rules] ${r.key} d=${d?.toFixed(2) ?? 'n/a'} ${kept ? 'kept' : `dropped (> ${PROCEDURE_DISTANCE_THRESHOLD} gate)`}`);
                });
                const nearRules = rules.filter(r => r.distance !== undefined && r.distance <= PROCEDURE_DISTANCE_THRESHOLD);
                nearRules.forEach(r => ruleStats.push({ key: r.key, distance: r.distance }));
                const near = nearRules
                    .map(r => r.value as unknown as ProceduralValue)
                    .filter(v => !!v?.instruction && !!v?.trigger);
                if (near.length > 0) {
                    proceduresSection = formatProceduresSection(near);
                }
            } catch (err: any) {
                console.warn(`[MemoryRecall] Procedural search failed: ${err?.message ?? err}`);
            }
        }

        // ── Episodic few-shot replay — distance-gated, no LLM filter ────────
        let episodesSection = "";
        if (episodicMemoryEnabled(tenantId)) {
            try {
                const eps = await getMemoryService().recall({
                    tenantId, userId, query, kinds: ["EPISODIC"], limit: EPISODE_RECALL_LIMIT,
                });
                eps.forEach(e => {
                    const d = e.distance;
                    const kept = d !== undefined && d <= EPISODE_DISTANCE_THRESHOLD;
                    console.log(`🧠 [RECALL:episodes] ${e.key} d=${d?.toFixed(2) ?? 'n/a'} ${kept ? 'replayed' : `dropped (> ${EPISODE_DISTANCE_THRESHOLD} gate)`}`);
                });
                const near = eps.filter(e => e.distance !== undefined && e.distance <= EPISODE_DISTANCE_THRESHOLD);
                near.forEach(e => episodeStats.push({ key: e.key, distance: e.distance }));
                if (near.length > 0) {
                    episodesSection = formatEpisodesSection(near.map(e => e.value as unknown as EpisodicValue));
                }
            } catch (err: any) {
                console.warn(`[MemoryRecall] Episodic search failed: ${err?.message ?? err}`);
            }
        }

        const memoryContext = composeMemoryContext(factsSection, episodesSection, proceduresSection);
        if (memoryContext) {
            console.log(`🧠 [RECALL] memoryContext assembled: facts(${factsSection ? 'yes' : 'no'}) rules(${proceduresSection ? 'yes' : 'no'}) episodes(${episodesSection ? 'yes' : 'no'}), ${memoryContext.length} chars`);
            if (memoryLogVerbose()) {
                console.log(`🧠 [RECALL] Injected into system prompt:\n────────\n${memoryContext}\n────────`);
            }
        } else {
            console.log("[MemoryRecall] Nothing relevant found");
        }
        return {
            memoryContext,
            memoryStats: {
                phase: 'recall',
                facts: factStats, rules: ruleStats, episodes: episodeStats,
                injected: memoryContext.length > 0,
            },
        };
    };
}

export function createMemorySaveNode(deps: MemoryNodeDeps) {
    const { reflectorModel, tenantId, userId, store } = deps;

    return async function memorySaveNode(state: MemoryNodeState, runtimeConfig?: any): Promise<{ memoryStats: MemorySaveStats | null }> {
        if (!store || !tenantId || !userId) {
            console.log("[MemorySave] Skipped — store, tenantId, or userId not available");
            return { memoryStats: null };
        }

        const { messages, taskDescription, memoryContext } = state;
        if (messages.length < 2) {
            console.log("[MemorySave] Skipped — conversation too short to extract learnings");
            return { memoryStats: null };
        }

        console.log(`\n🧠 [MEMORY SAVE] Analyzing session for learnings...`);

        let savedFacts = 0;
        let savedRules = 0;
        let reconcileActions: Record<string, number> | undefined;

        const recentMessages = messages.slice(-20);
        const conversationSummary = recentMessages.map(m => {
            const role = m._getType();
            const content = contentToText(m.content);
            return `[${role}] ${truncateOutput(content, 500)}`;
        }).join("\n\n");

        const extractPrompt = new SystemMessage(
            `You are a memory extraction engine. Analyze the completed agent session and extract facts worth remembering for future sessions.

**Categories and namespace conventions:**
- Infrastructure facts → namespace: ["infra", "<account-id-or-general>"]
  Examples: cluster regions, instance types, service configurations, resource counts
- User preferences → namespace: ["user", "preferences"]
  Examples: preferred output format, naming conventions, default regions, workflow preferences
- Task outcomes / solutions → namespace: ["patterns", "<service-type>"]
  Examples: how a scaling issue was resolved, successful deployment patterns
- Error resolutions → namespace: ["errors", "<service-type>"]
  Examples: how an OOM was fixed, what caused a timeout, permission error workarounds
` + (proceduralMemoryEnabled(tenantId) ? `- Operating rules → add "kind": "PROCEDURAL", namespace: ["procedures", "<domain>"]
  A rule for HOW the agent should behave in this environment, learned from this run.
  Extract a rule ONLY from a correction, a failure the run recovered from, or an explicit user preference about behavior.
  Shape: { "kind": "PROCEDURAL", "namespace": ["procedures", "aws-cli"], "key": "paginate-list-calls", "value": { "instruction": "Always paginate list/describe calls", "trigger": "any AWS CLI list operation", "evidence": "run truncated results and missed the target resource", "confidence": "high" } }
` : '') + `
**Rules:**
- Only extract facts that would be useful in a FUTURE session — skip ephemeral details
- Each memory must have confidence "high" or "medium" — skip anything uncertain
- Use descriptive, unique keys (e.g., "prod-ecs-cluster-region" not "fact-1")
- Do NOT re-save facts that already exist in the known memories below

**Return format:** A JSON array of objects:
` + '```' + `json
[{ "namespace": ["infra", "123456789"], "key": "prod-cluster-region", "value": { "fact": "Production ECS cluster runs in us-east-1", "source": "discovered via describe-clusters", "confidence": "high" } }]
` + '```' + `

Return an empty array ` + '`[]`' + ` if nothing new is worth saving.`
        );

        const extractInput = new HumanMessage({
            content: `**Original Task:** ${truncateOutput(taskDescription || "Unknown", 500)}

**Already Known (do NOT re-save):**
${memoryContext || "No existing memories."}

**Session Transcript (recent):**
${truncateOutput(conversationSummary, 8000)}

Extract memories to save.`
        });

        try {
            const response = await reflectorModel.invoke([extractPrompt, extractInput]);
            // contentToText, NOT JSON.stringify: Sonnet 5 returns a block ARRAY here, and
            // stringifying it made /\[[\s\S]*\]/ match the array of ~140 content blocks —
            // every "memory" then failed validation and all learnings were silently lost.
            const content = contentToText(response.content);

            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                console.log("[MemorySave] No JSON array found in response — nothing to save");
                return { memoryStats: { phase: 'save', savedFacts: 0, savedRules: 0, episodeCaptured: false } };
            }

            const memories: Array<{
                kind?: string;
                namespace: string[];
                key: string;
                value: Record<string, unknown>;
            }> = JSON.parse(jsonMatch[0]);

            const toSave = memories.filter(isValidExtractedItem);
            savedFacts = toSave.filter(m => m.kind !== 'PROCEDURAL').length;
            savedRules = toSave.filter(m => m.kind === 'PROCEDURAL').length;
            const kinds = toSave.map(m => `${m.key}[${m.kind === 'PROCEDURAL' ? 'PROCEDURAL' : 'SEMANTIC'}]`).join(', ');
            console.log(`🧠 [SAVE] Extracted ${toSave.length} item(s): ${kinds || '(none)'}`);
            if (toSave.length < memories.length) {
                console.log(`[MemorySave] Dropped ${memories.length - toSave.length} invalid/low-confidence item(s)`);
            }

            if (toSave.length === 0) {
                console.log("[MemorySave] No high/medium confidence memories to save");
                return { memoryStats: { phase: 'save', savedFacts: 0, savedRules: 0, episodeCaptured: false } };
            }

            if (reconcileEnabled(tenantId)) {
                console.log(`🧠 [MEMORY SAVE] Reconciling ${toSave.length} extracted facts...`);
                const threadId = runtimeConfig?.configurable?.thread_id as string | undefined;
                const summary = await reconcileMemories({
                    tenantId, userId,
                    facts: toSave.map(m => ({
                        kind: m.kind === 'PROCEDURAL' ? 'PROCEDURAL' as const : undefined,
                        namespace: m.namespace, key: m.key, value: m.value,
                    })) as unknown as ExtractedFact[],
                    judgeModel: reflectorModel,
                    sourceThreadId: threadId,
                });
                console.log(`🧠 [MEMORY SAVE] Reconcile: ${summary.added} added, ${summary.updated} updated, ${summary.superseded} superseded, ${summary.reinforced} reinforced, ${summary.noop} noop, ${summary.failed} failed`);
                reconcileActions = {
                    added: summary.added, updated: summary.updated, superseded: summary.superseded,
                    reinforced: summary.reinforced, noop: summary.noop, failed: summary.failed,
                };
            } else {
                console.log(`🧠 [MEMORY SAVE] Saving ${toSave.length} memories (reconcile disabled)...`);
                for (const mem of toSave) {
                    try {
                        if (mem.kind === 'PROCEDURAL') {
                            // Persist with the PROCEDURAL kind (saveMemory hardcodes SEMANTIC),
                            // matching how the reconcile-on path stores rules. Without this,
                            // procedural memory silently never works unless reconcile is also on,
                            // even though recall/extraction/skill-synthesis all still run.
                            await getMemoryService().remember({
                                tenantId, userId, kind: 'PROCEDURAL',
                                namespace: mem.namespace, key: mem.key,
                                value: mem.value as Record<string, unknown>,
                            });
                        } else {
                            await saveMemory(tenantId, userId, mem.namespace, mem.key, mem.value as Record<string, unknown>);
                        }
                        console.log(`   ✅ Saved: ${mem.namespace.join("/")}/${mem.key}${mem.kind === 'PROCEDURAL' ? ' [PROCEDURAL]' : ''}`);
                    } catch (err: any) {
                        console.warn(`   ⚠️ Failed to save ${mem.key}: ${err?.message ?? err}`);
                    }
                }
            }
        } catch (err: any) {
            console.warn(`[MemorySave] Extraction failed: ${err?.message ?? err}`);
        }

        // ── Episodic capture — independent of fact extraction; never blocks END ──
        const { plan, toolResults, errors, reflection, isComplete, iterationCount } = state;
        const threadIdForEpisode = runtimeConfig?.configurable?.thread_id as string | undefined;
        const shouldCapture = episodicMemoryEnabled(tenantId) && !!threadIdForEpisode && toolResults.length > 0;
        if (shouldCapture) {
            await captureEpisode({
                tenantId, userId, threadId: threadIdForEpisode,
                distillerModel: reflectorModel,
                taskDescription, plan, toolResults, errors, reflection, isComplete, iterationCount,
            });
        }

        // Autonomous skill synthesis — matured domains become/refresh enabled system skills (full Hermes).
        if (proceduralMemoryEnabled(tenantId)) {
            await synthesizeDomainSkills({ tenantId, threadId: threadIdForEpisode, distillerModel: reflectorModel });
        }

        return {
            memoryStats: {
                phase: 'save', savedFacts, savedRules,
                episodeCaptured: shouldCapture, reconcileActions,
            },
        };
    };
}

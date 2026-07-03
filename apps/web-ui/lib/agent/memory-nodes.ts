/**
 * memory-nodes.ts
 *
 * Shared memory_recall and memory_save graph nodes for all agent types.
 * memory_recall: semantic search + LLM relevance filter before task execution.
 * memory_save: LLM extraction of learnings after task completion.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ReflectionState, truncateOutput } from "./agent-shared";
import { saveMemory } from "./persistence";
import { getMemoryService } from "./memory/memory-service";
import {
    captureEpisode, episodicMemoryEnabled, formatEpisodesSection, composeMemoryContext,
    EPISODE_RECALL_LIMIT, EPISODE_DISTANCE_THRESHOLD,
} from "./memory/episode";
import { reconcileMemories, reconcileEnabled } from "./memory/reconcile";
import {
    proceduralMemoryEnabled, formatProceduresSection, isValidExtractedItem,
    PROCEDURE_RECALL_LIMIT, PROCEDURE_DISTANCE_THRESHOLD,
} from "./memory/procedural";
import type { ExtractedFact, EpisodicValue, ProceduralValue } from "./memory/types";

interface MemoryNodeDeps {
    reflectorModel: BaseChatModel;
    tenantId?: string;
    userId?: string;
    store: unknown | null;
}

export function createMemoryRecallNode(deps: MemoryNodeDeps) {
    const { reflectorModel, tenantId, userId, store } = deps;

    return async function memoryRecallNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        if (!store || !tenantId || !userId) {
            console.log("[MemoryRecall] Skipped — store, tenantId, or userId not available");
            return { memoryContext: "" };
        }

        const { messages } = state;
        const lastHuman = [...messages].reverse().find(m => m._getType() === "human");
        if (!lastHuman) {
            console.log("[MemoryRecall] Skipped — no human message found");
            return { memoryContext: "" };
        }

        const query = typeof lastHuman.content === "string"
            ? lastHuman.content
            : JSON.stringify(lastHuman.content);

        console.log(`\n🧠 [MEMORY RECALL] Searching memories for: "${truncateOutput(query, 100)}"`);

        // ── Semantic facts → existing LLM relevance filter ──────────────────
        let factsSection = "";
        try {
            const hits = await getMemoryService().recall({
                tenantId, userId, query, kinds: ["SEMANTIC"], limit: 10,
            });
            if (hits.length > 0) {
                console.log(`[MemoryRecall] Found ${hits.length} raw facts, filtering for relevance...`);
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
                    const content = typeof response.content === "string"
                        ? response.content
                        : JSON.stringify(response.content);
                    factsSection = (content.trim() === "NONE") ? "" : content.trim();
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
        if (proceduralMemoryEnabled()) {
            try {
                const rules = await getMemoryService().recall({
                    tenantId, userId, query, kinds: ["PROCEDURAL"], limit: PROCEDURE_RECALL_LIMIT,
                });
                const near = rules
                    .filter(r => r.distance !== undefined && r.distance <= PROCEDURE_DISTANCE_THRESHOLD)
                    .map(r => r.value as unknown as ProceduralValue)
                    .filter(v => !!v?.instruction && !!v?.trigger);
                if (near.length > 0) {
                    console.log(`🧠 [MEMORY RECALL] Applying ${near.length} learned operating rule(s)`);
                    proceduresSection = formatProceduresSection(near);
                }
            } catch (err: any) {
                console.warn(`[MemoryRecall] Procedural search failed: ${err?.message ?? err}`);
            }
        }

        // ── Episodic few-shot replay — distance-gated, no LLM filter ────────
        let episodesSection = "";
        if (episodicMemoryEnabled()) {
            try {
                const eps = await getMemoryService().recall({
                    tenantId, userId, query, kinds: ["EPISODIC"], limit: EPISODE_RECALL_LIMIT,
                });
                const near = eps.filter(e => e.distance !== undefined && e.distance <= EPISODE_DISTANCE_THRESHOLD);
                if (near.length > 0) {
                    console.log(`🧠 [MEMORY RECALL] Replaying ${near.length} past episode(s)`);
                    episodesSection = formatEpisodesSection(near.map(e => e.value as unknown as EpisodicValue));
                }
            } catch (err: any) {
                console.warn(`[MemoryRecall] Episodic search failed: ${err?.message ?? err}`);
            }
        }

        const memoryContext = composeMemoryContext(factsSection, episodesSection, proceduresSection);
        if (memoryContext) {
            console.log(`🧠 [MEMORY RECALL] Injecting relevant memories into context`);
        } else {
            console.log("[MemoryRecall] Nothing relevant found");
        }
        return { memoryContext };
    };
}

export function createMemorySaveNode(deps: MemoryNodeDeps) {
    const { reflectorModel, tenantId, userId, store } = deps;

    return async function memorySaveNode(state: ReflectionState, runtimeConfig?: any): Promise<Partial<ReflectionState>> {
        if (!store || !tenantId || !userId) {
            console.log("[MemorySave] Skipped — store, tenantId, or userId not available");
            return {};
        }

        const { messages, taskDescription, memoryContext } = state;
        if (messages.length < 2) {
            console.log("[MemorySave] Skipped — conversation too short to extract learnings");
            return {};
        }

        console.log(`\n🧠 [MEMORY SAVE] Analyzing session for learnings...`);

        const recentMessages = messages.slice(-20);
        const conversationSummary = recentMessages.map(m => {
            const role = m._getType();
            const content = typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content);
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
` + (proceduralMemoryEnabled() ? `- Operating rules → add "kind": "PROCEDURAL", namespace: ["procedures", "<domain>"]
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
            const content = typeof response.content === "string"
                ? response.content
                : JSON.stringify(response.content);

            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                console.log("[MemorySave] No JSON array found in response — nothing to save");
                return {};
            }

            const memories: Array<{
                kind?: string;
                namespace: string[];
                key: string;
                value: Record<string, unknown>;
            }> = JSON.parse(jsonMatch[0]);

            const toSave = memories.filter(isValidExtractedItem);
            if (toSave.length < memories.length) {
                console.log(`[MemorySave] Dropped ${memories.length - toSave.length} invalid/low-confidence item(s)`);
            }

            if (toSave.length === 0) {
                console.log("[MemorySave] No high/medium confidence memories to save");
                return {};
            }

            if (reconcileEnabled()) {
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
            } else {
                console.log(`🧠 [MEMORY SAVE] Saving ${toSave.length} memories (reconcile disabled)...`);
                for (const mem of toSave) {
                    if (mem.kind === 'PROCEDURAL') {
                        console.log(`   ⏭️ Skipped procedural rule ${mem.key} (reconcile disabled)`);
                        continue;
                    }
                    try {
                        await saveMemory(tenantId, userId, mem.namespace, mem.key, mem.value as Record<string, unknown>);
                        console.log(`   ✅ Saved: ${mem.namespace.join("/")}/${mem.key}`);
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
        if (episodicMemoryEnabled() && threadIdForEpisode && toolResults.length > 0) {
            await captureEpisode({
                tenantId, userId, threadId: threadIdForEpisode,
                distillerModel: reflectorModel,
                taskDescription, plan, toolResults, errors, reflection, isComplete, iterationCount,
            });
        }

        return {};
    };
}

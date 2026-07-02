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
import { searchMemory, saveMemory } from "./persistence";
import { reconcileMemories, reconcileEnabled } from "./memory/reconcile";
import type { ExtractedFact } from "./memory/types";

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

        let rawResults: Array<{ key: string; value: unknown; namespace: string }>;
        try {
            // Recall spans all memory kinds (SEMANTIC today; EPISODIC/PROCEDURAL in later phases).
            const results = await searchMemory(tenantId, userId, [], query, 10);
            rawResults = (results as Array<{ key: string; value: unknown; namespace: string }>) ?? [];
        } catch (err: any) {
            console.warn(`[MemoryRecall] Search failed: ${err?.message ?? err}`);
            return { memoryContext: "" };
        }

        if (rawResults.length === 0) {
            console.log("[MemoryRecall] No memories found");
            return { memoryContext: "" };
        }

        console.log(`[MemoryRecall] Found ${rawResults.length} raw memories, filtering for relevance...`);

        const memorySummary = rawResults.map((m, i) =>
            `${i + 1}. [${m.namespace}/${m.key}] ${JSON.stringify(m.value)}`
        ).join("\n");

        let relevantMemories: string;
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

            if (content.trim() === "NONE" || !content.trim()) {
                console.log("[MemoryRecall] No relevant memories after filtering");
                return { memoryContext: "" };
            }

            relevantMemories = content.trim();
        } catch (err: any) {
            console.warn(`[MemoryRecall] Relevance filter failed: ${err?.message ?? err}`);
            relevantMemories = rawResults.slice(0, 5).map(m =>
                `- [${m.namespace}/${m.key}] ${JSON.stringify(m.value)}`
            ).join("\n");
        }

        console.log(`🧠 [MEMORY RECALL] Injecting relevant memories into context`);

        return { memoryContext: relevantMemories };
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
                namespace: string[];
                key: string;
                value: { fact: string; source: string; confidence: string };
            }> = JSON.parse(jsonMatch[0]);

            const toSave = memories.filter(m =>
                m.value?.confidence === "high" || m.value?.confidence === "medium"
            );

            if (toSave.length === 0) {
                console.log("[MemorySave] No high/medium confidence memories to save");
                return {};
            }

            if (reconcileEnabled()) {
                console.log(`🧠 [MEMORY SAVE] Reconciling ${toSave.length} extracted facts...`);
                const threadId = runtimeConfig?.configurable?.thread_id as string | undefined;
                const summary = await reconcileMemories({
                    tenantId, userId,
                    facts: toSave.map(m => ({ namespace: m.namespace, key: m.key, value: m.value })) as ExtractedFact[],
                    judgeModel: reflectorModel,
                    sourceThreadId: threadId,
                });
                console.log(`🧠 [MEMORY SAVE] Reconcile: ${summary.added} added, ${summary.updated} updated, ${summary.superseded} superseded, ${summary.reinforced} reinforced, ${summary.noop} noop, ${summary.failed} failed`);
            } else {
                console.log(`🧠 [MEMORY SAVE] Saving ${toSave.length} memories (reconcile disabled)...`);
                for (const mem of toSave) {
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

        return {};
    };
}

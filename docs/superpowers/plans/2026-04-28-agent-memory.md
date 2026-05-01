# Agent Long-Term Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI agent automatically recall relevant memories before every task and save new learnings after every task, enabling self-improvement across sessions.

**Architecture:** Two new deterministic graph nodes (`memory_recall`, `memory_save`) added to both fast-agent and planning-agent. Recall runs semantic search + LLM relevance filter before the first working node. Save runs LLM extraction after the final node. Both use the reflector model (non-streaming, cheap).

**Tech Stack:** LangGraph StateGraph, PostgreSQL + pgvector via Prisma, Bedrock Titan embeddings, `@langchain/core` messages

**Spec:** `docs/superpowers/specs/2026-04-28-agent-memory-design.md`

---

### Task 1: Fix namespace prefix filter bug in persistence.ts

**Files:**
- Modify: `web-ui/lib/agent/persistence.ts:136-166`

The search operation ignores the `namespacePrefix` parameter — it returns all tenant memories regardless of namespace. This must be fixed before the new nodes can do targeted searches.

- [ ] **Step 1: Fix the vector search query to filter by namespace prefix**

In `web-ui/lib/agent/persistence.ts`, find the search operation branch (line ~136). Replace the vector search query (lines 150-157) with one that filters by namespace prefix:

```typescript
// Inside the `else if (op.namespacePrefix !== undefined && op.query !== undefined)` branch:

// Search operation
const query = String(op.query);
const limit = Number(op.limit ?? 5);
const tenantId = configurable?.tenant_id as string ?? "default";
const namespacePrefix = Array.isArray(op.namespacePrefix)
    ? (op.namespacePrefix as string[]).join("/")
    : "";

let queryEmbedding: number[] | null = null;
try {
    queryEmbedding = await this.embeddings.embedQuery(query);
} catch {
    // fallback to text search
}

if (queryEmbedding) {
    const embeddingStr = `[${queryEmbedding.join(",")}]`;
    const rows = namespacePrefix
        ? await prisma.$queryRaw<Array<{ key: string; value: unknown; namespace: string }>>`
            SELECT "key", "value", "namespace"
            FROM agent_memories
            WHERE "tenantId" = ${tenantId}
              AND "namespace" LIKE ${namespacePrefix + '%'}
            ORDER BY embedding <=> ${embeddingStr}::vector
            LIMIT ${limit}
          `
        : await prisma.$queryRaw<Array<{ key: string; value: unknown; namespace: string }>>`
            SELECT "key", "value", "namespace"
            FROM agent_memories
            WHERE "tenantId" = ${tenantId}
            ORDER BY embedding <=> ${embeddingStr}::vector
            LIMIT ${limit}
          `;
    results.push(rows.map((r) => ({ key: r.key, value: r.value, namespace: r.namespace })));
} else {
    const rows = namespacePrefix
        ? await prisma.agentMemory.findMany({
            where: { tenantId, namespace: { startsWith: namespacePrefix } },
            take: limit,
            orderBy: { createdAt: "desc" },
          })
        : await prisma.agentMemory.findMany({
            where: { tenantId },
            take: limit,
            orderBy: { createdAt: "desc" },
          });
    results.push(rows.map((r) => ({ key: r.key, value: r.value, namespace: r.namespace })));
}
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/lib/agent/persistence.ts
git commit -m "fix: add namespace prefix filtering to memory search queries"
```

---

### Task 2: Remove dead LONG_TERM_MEMORY_GUIDANCE from prompt-templates.ts

**Files:**
- Modify: `web-ui/lib/agent/prompt-templates.ts:266-291`

- [ ] **Step 1: Delete the dead constant**

In `web-ui/lib/agent/prompt-templates.ts`, delete lines 266-291 (the entire `LONG_TERM_MEMORY_GUIDANCE` export and its JSDoc comment). This constant is never imported anywhere and will be replaced by dynamic `memoryContext` from the recall node.

Remove this entire block:

```typescript
// ---------------------------------------------------------------------------
// LONG-TERM MEMORY
// ---------------------------------------------------------------------------

/**
 * Injected when the memory store is available.
 * Instructs the agent on how to use cross-session long-term memory.
 */
export const LONG_TERM_MEMORY_GUIDANCE = `
## Long-Term Memory
...
`;
```

- [ ] **Step 2: Commit**

```bash
git add web-ui/lib/agent/prompt-templates.ts
git commit -m "refactor: remove dead LONG_TERM_MEMORY_GUIDANCE constant"
```

---

### Task 3: Add memoryContext to ReflectionState in agent-shared.ts

**Files:**
- Modify: `web-ui/lib/agent/agent-shared.ts:28-93`

- [ ] **Step 1: Add memoryContext field to the ReflectionState interface**

In `web-ui/lib/agent/agent-shared.ts`, add `memoryContext` to the `ReflectionState` interface (after line 39, the `toolResults` field):

```typescript
export interface ReflectionState {
    messages: BaseMessage[];
    taskDescription: string;
    plan: PlanStep[];
    code: string;
    executionOutput: string;
    errors: string[];
    reflection: string;
    iterationCount: number;
    nextAction: string;
    isComplete: boolean;
    toolResults: ToolResultEntry[];
    memoryContext: string; // Formatted relevant memories from recall node
}
```

- [ ] **Step 2: Add memoryContext channel to graphState**

In the same file, add the `memoryContext` channel to the `graphState` object (after the `toolResults` channel, before the closing `}`):

```typescript
    memoryContext: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
```

- [ ] **Step 3: Commit**

```bash
git add web-ui/lib/agent/agent-shared.ts
git commit -m "feat: add memoryContext field to ReflectionState and graphState"
```

---

### Task 4: Create shared memory node functions in a new memory-nodes.ts

**Files:**
- Create: `web-ui/lib/agent/memory-nodes.ts`

Both agents need identical memory_recall and memory_save logic. Extract into a shared module to avoid duplication.

- [ ] **Step 1: Create memory-nodes.ts with the memoryRecallNode function**

Create `web-ui/lib/agent/memory-nodes.ts`:

```typescript
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
```

- [ ] **Step 2: Add the createMemorySaveNode function to memory-nodes.ts**

Append to `web-ui/lib/agent/memory-nodes.ts`:

```typescript
export function createMemorySaveNode(deps: MemoryNodeDeps) {
    const { reflectorModel, tenantId, userId, store } = deps;

    return async function memorySaveNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
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
\`\`\`json
[{ "namespace": ["infra", "123456789"], "key": "prod-cluster-region", "value": { "fact": "Production ECS cluster runs in us-east-1", "source": "discovered via describe-clusters", "confidence": "high" } }]
\`\`\`

Return an empty array \`[]\` if nothing new is worth saving.`
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
                m.confidence === undefined || m.value?.confidence === "high" || m.value?.confidence === "medium"
            );

            if (toSave.length === 0) {
                console.log("[MemorySave] No high/medium confidence memories to save");
                return {};
            }

            console.log(`🧠 [MEMORY SAVE] Saving ${toSave.length} memories...`);

            for (const mem of toSave) {
                try {
                    await saveMemory(tenantId, userId, mem.namespace, mem.key, mem.value as Record<string, unknown>);
                    console.log(`   ✅ Saved: ${mem.namespace.join("/")}/${mem.key}`);
                } catch (err: any) {
                    console.warn(`   ⚠️ Failed to save ${mem.key}: ${err?.message ?? err}`);
                }
            }
        } catch (err: any) {
            console.warn(`[MemorySave] Extraction failed: ${err?.message ?? err}`);
        }

        return {};
    };
}
```

- [ ] **Step 3: Commit**

```bash
git add web-ui/lib/agent/memory-nodes.ts
git commit -m "feat: create shared memory_recall and memory_save node functions"
```

---

### Task 5: Wire memory nodes into fast-agent.ts

**Files:**
- Modify: `web-ui/lib/agent/fast-agent.ts`

- [ ] **Step 1: Add imports for memory node creators**

At the top of `web-ui/lib/agent/fast-agent.ts`, add the import after the existing imports (after line 29):

```typescript
import { createMemoryRecallNode, createMemorySaveNode } from "./memory-nodes";
```

- [ ] **Step 2: Create memory node instances after model/tool setup**

In `createFastGraph`, after the tool assembly block (after line 64, `const toolNode = new ToolNode(tools);`), add:

```typescript
    // --- Memory Nodes ---
    const memoryDeps = { reflectorModel, tenantId, userId: config.userId, store };
    const memoryRecallNode = createMemoryRecallNode(memoryDeps);
    const memorySaveNode = createMemorySaveNode(memoryDeps);
```

- [ ] **Step 3: Inject memoryContext into the agent system prompt**

In the `agentNode` function (line ~79), add the memory section to the system prompt. Find the line that builds `systemPrompt` (line 79) and add `memorySection` into the template:

```typescript
    async function agentNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, iterationCount, memoryContext } = state;

        // ... existing logging ...

        const baseIdentity = buildBaseIdentity(selectedSkill);

        const memorySection = memoryContext
            ? `\n## Relevant Context from Memory\n${memoryContext}\n`
            : '';

        const systemPrompt = new SystemMessage(`${baseIdentity}
${effectiveSkillSection}
${CORE_PRINCIPLES}
${awsCliStandards}
${autoApproveGuidance}
${operationalWorkflows}
${accountContext}
${memorySection}
// ... rest of the prompt unchanged ...
```

Note: Only the destructuring line and the `memorySection` variable + injection are new. The rest of the system prompt stays exactly as-is.

- [ ] **Step 4: Register memory nodes and rewire the graph**

Replace the graph construction section (lines 313-341) with:

```typescript
    // ---------------------------------------------------------------------------
    // GRAPH CONSTRUCTION
    // ---------------------------------------------------------------------------
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("memory_recall", memoryRecallNode)
        .addNode("agent", agentNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)
        .addNode("memory_save", memorySaveNode)

        .addEdge(START, "memory_recall")
        .addEdge("memory_recall", "agent")

        .addConditionalEdges("agent", shouldContinue, {
            tools: "tools",
            reflect: "reflect",
            __end__: "memory_save"
        })

        .addConditionalEdges("reflect", shouldContinueFromReflect, {
            agent: "agent",
            __end__: "memory_save"
        })

        .addEdge("tools", "agent")
        .addEdge("memory_save", END);
```

Note: The conditional edges that previously returned `END` (`__end__`) now route to `"memory_save"` instead. The `memory_save` node has an unconditional edge to `END`.

- [ ] **Step 5: Update shouldContinue return type**

The `shouldContinue` function (line ~278) currently returns `"tools" | "reflect" | "__end__"`. Update the `__end__` case to return `"memory_save"` instead:

```typescript
    function shouldContinue(state: ReflectionState): "tools" | "reflect" | "memory_save" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;
        const { iterationCount } = state;

        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "tools";
        }

        if (iterationCount >= MAX_ITERATIONS) {
            console.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached. Stopping.`);
            return "memory_save";
        }

        if (iterationCount >= MAX_REFLECT_ITERATIONS) {
            console.log(`⚠️ Max reflection cycles (${MAX_REFLECT_ITERATIONS}) reached. Accepting answer.`);
            return "memory_save";
        }

        return "reflect";
    }

    function shouldContinueFromReflect(state: ReflectionState): "agent" | "memory_save" {
        if (state.isComplete) {
            return "memory_save";
        }
        return "agent";
    }
```

- [ ] **Step 6: Commit**

```bash
git add web-ui/lib/agent/fast-agent.ts
git commit -m "feat: wire memory_recall and memory_save nodes into fast-agent graph"
```

---

### Task 6: Wire memory nodes into planning-agent.ts

**Files:**
- Modify: `web-ui/lib/agent/planning-agent.ts`

- [ ] **Step 1: Add imports for memory node creators**

At the top of `web-ui/lib/agent/planning-agent.ts`, add the import after the existing imports (after line 29):

```typescript
import { createMemoryRecallNode, createMemorySaveNode } from "./memory-nodes";
```

- [ ] **Step 2: Create memory node instances after model/tool setup**

In `createReflectionGraph`, after the tool assembly block (after line 66, `const toolNode = new ToolNode(tools);`), add:

```typescript
    // --- Memory Nodes ---
    const memoryDeps = { reflectorModel, tenantId, userId: config.userId, store };
    const memoryRecallNode = createMemoryRecallNode(memoryDeps);
    const memorySaveNode = createMemorySaveNode(memoryDeps);
```

- [ ] **Step 3: Inject memoryContext into the planner system prompt**

In the `planNode` function (line ~70), destructure `memoryContext` from state and add it to the planner system prompt:

```typescript
    async function planNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, memoryContext } = state;
        // ... existing code ...

        const memorySection = memoryContext
            ? `\n## Relevant Context from Memory\n${memoryContext}\n`
            : '';

        const plannerSystemPrompt = new SystemMessage(`${baseIdentity}
Your role is to decompose the user's task into a precise, dependency-ordered execution plan.
${effectiveSkillSection}
${CORE_PRINCIPLES}
${memorySection}
## Planning Methodology
// ... rest unchanged ...
```

- [ ] **Step 4: Inject memoryContext into the executor system prompt**

In the `generateNode` function (line ~163), destructure `memoryContext` from state and add it:

```typescript
    async function generateNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, plan, iterationCount, memoryContext } = state;
        // ... existing code ...

        const memorySection = memoryContext
            ? `\n## Relevant Context from Memory\n${memoryContext}\n`
            : '';

        const executorSystemPrompt = new SystemMessage(`${baseIdentity}
Your role is to execute the current plan step precisely and completely using available tools.
${effectiveSkillSection}
${CORE_PRINCIPLES}
${memorySection}
## Current Execution Context
// ... rest unchanged ...
```

- [ ] **Step 5: Register memory nodes and rewire the graph**

Replace the graph construction section (lines 623-668) with:

```typescript
    // ---------------------------------------------------------------------------
    // GRAPH CONSTRUCTION
    // ---------------------------------------------------------------------------
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("memory_recall", memoryRecallNode)
        .addNode("planner", planNode)
        .addNode("generate", generateNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)
        .addNode("revise", reviseNode)
        .addNode("final", finalNode)
        .addNode("memory_save", memorySaveNode)

        .addEdge(START, "memory_recall")
        .addEdge("memory_recall", "planner")
        .addEdge("planner", "generate")

        .addConditionalEdges("generate", shouldContinueFromGenerate, {
            tools: "tools",
            reflect: "reflect",
            final: "final"
        })

        .addConditionalEdges("tools", shouldContinueFromTools, {
            generate: "generate",
            reflect: "reflect"
        })

        .addConditionalEdges("reflect", shouldContinueFromReflect, {
            revise: "revise",
            final: "final"
        })

        .addConditionalEdges("revise", shouldContinueFromRevise, {
            tools: "tools",
            reflect: "reflect"
        })

        .addEdge("final", "memory_save")
        .addEdge("memory_save", END);
```

Note: The only topology change is: `START → memory_recall → planner` (instead of `START → planner`) and `final → memory_save → END` (instead of `final → END`).

- [ ] **Step 6: Commit**

```bash
git add web-ui/lib/agent/planning-agent.ts
git commit -m "feat: wire memory_recall and memory_save nodes into planning-agent graph"
```

---

### Task 7: Verify TypeScript compilation

**Files:**
- None (verification only)

- [ ] **Step 1: Run TypeScript type check on web-ui**

```bash
cd web-ui && npx tsc --noEmit
```

Expected: No type errors. If there are errors, they will be in the files we modified — fix them before proceeding.

- [ ] **Step 2: Run existing agent tests to check for regressions**

```bash
cd web-ui && npm run test -- --run
```

Expected: All existing tests pass. The memory nodes are additive — they shouldn't break existing behavior.

- [ ] **Step 3: Run lint**

```bash
cd web-ui && npm run lint
```

Expected: No new lint errors.

- [ ] **Step 4: Commit any fixes if needed**

```bash
git add -A
git commit -m "fix: resolve type/lint issues from memory node integration"
```

Only run this step if Steps 1-3 surfaced issues that required fixes.

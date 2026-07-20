import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { getSkillContent, getSkillSummaries } from "@/lib/skill-service";
import {
    GraphConfig,
    ReflectionState,
    ToolResultEntry,
    graphState,
    MAX_ITERATIONS,
    truncateOutput,
    contentToText,
    isToolResultError,
    sanitizeMessagesForBedrock,
    withUnresolvedToolCallsOnly,
    tagMessagePhase,
    getCheckpointer,
    getStore,
    extractTextContent,
} from "./agent-shared";

import {
    buildBaseIdentity,
    buildEffectiveSkillSection,
    buildAccountContext,
    buildAwsCliStandards,
    buildAutoApproveGuidance,
    buildOperationalWorkflows,
    CORE_PRINCIPLES,
} from "./prompt-templates";
import { createAgentModels, assembleTools } from "./model-factory";
import { createMemoryRecallNode, createMemorySaveNode } from "./memory-nodes";
import { autoSkillSelectionEnabled } from "./auto-skill-select";
import { prepareContext, buildWorkingMemorySection } from "./memory/working-memory";
import { createGuardNode } from "./guard";
import { routeAfterGuard } from "./gate-routing";

// --- FAST GRAPH (Reflection Agent Mode) ---
export async function createFastGraph(config: GraphConfig) {
    const { model: modelConfig, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds, tenantId } = config;
    const modelId = modelConfig.modelId;
    const checkpointer = await getCheckpointer();
    const store = await getStore();

    // Pre-fetch skill content once (tenant-scoped DB lookup). Used by the system
    // prompt and reused by the reflector below — no repeated queries.
    const skillContent = selectedSkill && tenantId ? (await getSkillContent(tenantId, selectedSkill)) || '' : '';
    if (selectedSkill) {
        console.log(skillContent ? `[FastAgent] Loaded skill: ${selectedSkill}` : `[FastAgent] No content for skill: ${selectedSkill}`);
    }
    // Catalog rides the auto-selection feature flag (true kill-switch) and the
    // zero-skill sentinel string must not leak into the prompt.
    const skillCatalog = !selectedSkill && tenantId && autoSkillSelectionEnabled()
        ? await getSkillSummaries(tenantId)
            .then(s => (s.startsWith('No specialized skills') ? null : s))
            .catch(() => null)
        : null;
    const effectiveSkillSection = buildEffectiveSkillSection(selectedSkill, skillContent || null, skillCatalog);

    // --- Shared prompt fragments (built once, reused across all nodes) ---
    const accountContext = buildAccountContext({ accounts, accountId, accountName });
    const awsCliStandards = buildAwsCliStandards();
    const autoApproveGuidance = buildAutoApproveGuidance(autoApprove);
    const operationalWorkflows = buildOperationalWorkflows();

    // --- Model Initialization ---
    const { main: model, reflector: reflectorModel } = createAgentModels(modelConfig);

    // --- Tool Assembly (fast-agent does not use S3 tools) ---
    // Memory tools excluded — memory_recall and memory_save graph nodes handle memory deterministically
    const tools = await assembleTools({ includeS3Tools: false, includeMemoryTools: false, userId: config.userId, mcpServerIds, tenantId, accounts, knowledgeBaseIds: config.knowledgeBaseIds });
    const modelWithTools = model.bindTools!(tools);
    const toolNode = new ToolNode(tools);

    // --- Memory Nodes ---
    const memoryDeps = { reflectorModel, tenantId, userId: config.userId, store };
    const memoryRecallNode = createMemoryRecallNode(memoryDeps);
    const memorySaveNode = createMemorySaveNode(memoryDeps);

    const guardNode = createGuardNode({ riskModel: reflectorModel });
    // approval_gate is a no-op marker node: the interrupt BEFORE it is the pause.
    async function approvalGateNode(): Promise<Partial<ReflectionState>> {
        console.log('⏸️ [APPROVAL GATE] resuming after human decision');
        return {};
    }

    // Working-memory deps — threadId is read per-node from the runtime config.
    const wmDeps = { reflectorModel, tenantId, userId: config.userId };

    // ---------------------------------------------------------------------------
    // AGENT NODE
    // ---------------------------------------------------------------------------
    async function agentNode(state: ReflectionState, runtimeConfig?: any): Promise<Partial<ReflectionState>> {
        const { messages, iterationCount, memoryContext } = state;

        console.log(`\n================================================================================`);
        console.log(`🚀 [FAST AGENT] Generator Iteration ${iterationCount + 1}/${MAX_ITERATIONS}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const baseIdentity = buildBaseIdentity(selectedSkill);

        const memorySection = memoryContext
            ? `\n## Relevant Context from Memory\n${memoryContext}\n`
            : '';

        const threadId = runtimeConfig?.configurable?.thread_id as string | undefined;
        const { windowMessages, workingMemorySection, stateUpdate } =
            await prepareContext(state, { ...wmDeps, threadId }, 20);

        const systemPrompt = new SystemMessage(`${baseIdentity}
${effectiveSkillSection}
${CORE_PRINCIPLES}
${awsCliStandards}
${autoApproveGuidance}
${operationalWorkflows}
${accountContext}
${memorySection}
${workingMemorySection}
## Conversation Continuity

Review the full conversation history before responding:
- For follow-up questions, reference findings, resource IDs, and outputs from previous turns directly — do not re-discover what is already known.
- If a previous tool result is relevant to the current question, cite it rather than re-running the same command.
- If the user's intent is ambiguous given prior context, state your interpretation before proceeding.

## Response Discipline

- Answer the user's request directly and completely.
- If tools are needed, call them. If the question is factual or conversational, answer without tools.
- No preamble or postamble: do not announce what you are about to do, and do not recap what you just did — the tool calls and results are already visible to the user. Give the answer itself.
- Match the shape of the request: a direct question gets a direct answer; only use headings/tables when the content genuinely needs them.
- Be precise: include resource IDs, command flags, numeric values, and account names in your responses where available.`);

        const safeMessages = sanitizeMessagesForBedrock(windowMessages);
        const response = await modelWithTools.invoke([systemPrompt, ...safeMessages]);

        if ('tool_calls' in response && response.tool_calls && response.tool_calls.length > 0) {
            console.log(`\n🛠️ [FAST AGENT] Tool Calls Generated:`);
            for (const toolCall of response.tool_calls) {
                console.log(`   → Tool: ${toolCall.name}`);
                console.log(`     Args: ${JSON.stringify(toolCall.args)}`);
            }
        } else {
            console.log(`\n💬 [FAST AGENT] No tools called. Generating text response.`);
        }

        return {
            messages: [tagMessagePhase(response, 'execution')],
            iterationCount: iterationCount + 1,
            ...stateUpdate,
        };
    }

    // ---------------------------------------------------------------------------
    // TOOL NODE (with result collection)
    // ---------------------------------------------------------------------------
    async function collectingToolNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        console.log(`\n⚙️ [FAST TOOLS] Executing tool calls...`);
        const view = withUnresolvedToolCallsOnly(state);
        if (!view) {
            console.log('⚙️ [FAST TOOLS] All tool calls already resolved (rejected/answered) — skipping execution.');
            return {};
        }
        const result = await toolNode.invoke({ ...state, messages: view.messages });
        console.log(`⚙️ [FAST TOOLS] Execution complete. Result messages: ${result.messages?.length || 0}`);

        const newToolResults: ToolResultEntry[] = [];
        if (result.messages) {
            for (const msg of result.messages) {
                if (msg._getType() === 'tool') {
                    const rawContent = contentToText(msg.content);
                    // Precise classifier (status flag / error-prefix / success:false JSON) —
                    // the old substring match flagged ANY output mentioning "error", e.g. a
                    // successful CloudWatch query for the "Errors" metric.
                    const isError = isToolResultError((msg as ToolMessage).status, rawContent);
                    newToolResults.push({
                        toolName: (msg as any).name || 'unknown_tool',
                        output: truncateOutput(rawContent, 1000),
                        isError,
                        iterationIndex: state.iterationCount,
                    });
                    const icon = isError ? '❌' : '✅';
                    console.log(`   ${icon} [TOOL RESULT] ${(msg as any).name || 'Unknown Tool'}:`);
                    console.log(`      ${truncateOutput(rawContent, 200).replace(/\n/g, '\n      ')}`);
                }
            }
        }
        return { ...result, toolResults: newToolResults };
    }

    // Kept as a thin alias — the canonical implementation is extractTextContent()
    // in agent-shared.ts, which every graph now shares.
    const getStringContent = extractTextContent;

    // ---------------------------------------------------------------------------
    // FINALIZE NODE
    // ---------------------------------------------------------------------------
    // Reached only when the iteration cap is hit while the model still wants to call
    // tools. Those tool calls will NOT run, so we make one final model call WITHOUT
    // tools to synthesize a natural-language answer from everything gathered so far.
    // Without this, the graph would end on an unanswered tool_use message and the
    // user would receive an empty ("placeholder") response.
    async function finalizeNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, memoryContext, toolResults } = state;
        const workingMemorySection = buildWorkingMemorySection(
            state.runningSummary || (state.scratchpad?.openGoals?.length ?? 0) > 0
                ? { runningSummary: state.runningSummary ?? '', scratchpad: state.scratchpad ?? { openGoals: [], keyFindings: [], resourceIds: [], pendingSteps: [] }, tokenCount: 0, turnCount: 0 }
                : null,
        );

        console.log(`\n================================================================================`);
        console.log(`🏁 [FAST AGENT] Iteration cap reached — synthesizing final answer (no tools)`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        // Original request = the first human message in the thread.
        const firstHuman = messages.find(m => m._getType() === 'human');
        const originalQuery = firstHuman ? getStringContent(firstHuman.content as any) : '(original request unavailable)';

        // Gathered context as PLAIN TEXT. We must NOT pass the raw conversation history to a
        // tool-less model.invoke(): the history contains tool_use/tool_result content blocks,
        // and a request without `toolConfig` (which only modelWithTools sends) is rejected by
        // Bedrock — "The toolConfig field must be defined when using toolUse and toolResult
        // content blocks." So we embed findings as text and send one fresh HumanMessage, the
        // same pattern the planning-agent's final node uses.
        const toolSummary = toolResults.length > 0
            ? toolResults
                .slice(-8)
                .map(e => `[${e.isError ? '❌ ERROR' : '✅'} ${e.toolName}]\n${truncateOutput(e.output, 600)}`)
                .join('\n\n---\n\n')
            : '(no tool output was captured)';

        const baseIdentity = buildBaseIdentity(selectedSkill);
        const memorySection = memoryContext
            ? `\n## Relevant Context from Memory\n${memoryContext}\n`
            : '';

        const finalizeSystemPrompt = new SystemMessage(`${baseIdentity}
${effectiveSkillSection}
${accountContext}
${memorySection}
${workingMemorySection}
## Final Answer

You can NOT run any more tools in this run. Using ONLY the information already gathered
(below), write a clear, complete answer to the user's original request.

### Original request
${truncateOutput(originalQuery, 2000)}

### Most recent tool outputs
${toolSummary}

Write a clear, markdown-formatted answer that:
- Leads with the answer to the user's request — include resource IDs, metrics, and command outputs where available.
- Calls out anything that could not be verified or completed, and why (this path was reached because the step budget ran out, so partial results are expected).
- Suggests a next step only if one is genuinely warranted — otherwise stop.`);

        const finalizeInput = new HumanMessage({
            content: `Provide the final answer now, based only on what has already been gathered.`,
        });

        try {
            // Tool-less model: no toolConfig is sent, and neither message contains tool blocks.
            const response = await model.invoke([finalizeSystemPrompt, finalizeInput]);
            return { messages: [tagMessagePhase(response, 'final')], isComplete: true };
        } catch (err: any) {
            // A finalize failure must NEVER crash the stream — return a best-effort text answer
            // so the user still gets the findings gathered before the cap was hit.
            console.error(`⚠️ [FAST AGENT] Finalize synthesis failed: ${err?.message ?? err}`);
            const fallback = `⚠️ I reached the maximum number of investigation steps before I could fully complete the analysis.

**Original request:** ${truncateOutput(originalQuery, 300)}

**What I gathered before stopping:**

${toolSummary}

Please narrow the question or ask me to continue from here.`;
            return { messages: [tagMessagePhase(new AIMessage({ content: fallback }), 'final')], isComplete: true };
        }
    }

    // ---------------------------------------------------------------------------
    // CONDITIONAL EDGES
    // ---------------------------------------------------------------------------
    // Pure ReAct decision: loop through tools while the model wants them, otherwise
    // the model has produced its answer — persist memory and finish. No reflection/
    // revision cycle (that rigor lives in the planning agent).
    function shouldContinue(state: ReflectionState): "guard" | "finalize" | "memory_save" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;
        const { iterationCount } = state;
        const hasPendingToolCalls = !!(lastMessage.tool_calls && lastMessage.tool_calls.length > 0);

        // Hard cap FIRST — prevents unbounded loops when model keeps generating tool_calls
        if (iterationCount >= MAX_ITERATIONS) {
            // If the model still wants tools, they will not run — synthesize a final answer
            // so the user never gets an empty response and we never persist an orphaned tool_use.
            if (hasPendingToolCalls) {
                console.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached with pending tool calls. Synthesizing final answer.`);
                return "finalize";
            }
            console.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached. Stopping.`);
            return "memory_save";
        }

        if (hasPendingToolCalls) {
            return "guard";
        }

        // Empty-answer guard: no tool calls AND no text (e.g. the model spent its
        // whole output budget on a reasoning block). Ending here would stream
        // nothing to the user — synthesize an answer from gathered results instead.
        if (!contentToText(lastMessage.content ?? '').trim()) {
            console.warn(`⚠️ [FAST AGENT] Empty final message — routing to finalize to synthesize an answer.`);
            return "finalize";
        }

        // No pending tool calls means the model produced its final answer — done.
        return "memory_save";
    }

    // ---------------------------------------------------------------------------
    // GRAPH CONSTRUCTION
    // ---------------------------------------------------------------------------
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("memory_recall", memoryRecallNode)
        .addNode("agent", agentNode)
        .addNode("guard", guardNode)
        .addNode("approval_gate", approvalGateNode)
        .addNode("tools", collectingToolNode)
        .addNode("finalize", finalizeNode)
        .addNode("memory_save", memorySaveNode)

        .addEdge(START, "memory_recall")
        .addEdge("memory_recall", "agent")

        .addConditionalEdges("agent", shouldContinue, {
            guard: "guard",
            finalize: "finalize",
            memory_save: "memory_save"
        })

        .addConditionalEdges("guard", (state: ReflectionState) => routeAfterGuard(state, autoApprove), {
            approval_gate: "approval_gate",
            tools: "tools"
        })
        .addEdge("approval_gate", "tools")

        .addEdge("tools", "agent")
        .addEdge("finalize", "memory_save")
        .addEdge("memory_save", END);

    return workflow.compile({
        checkpointer,
        ...(store && { store }),
        interruptBefore: ["approval_gate"],
    });
}

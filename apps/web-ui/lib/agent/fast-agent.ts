import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
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
    sanitizeMessagesForBedrock,
    tagMessagePhase,
    getCheckpointer,
    getStore,
} from "./agent-shared";

// Maximum number of reflection cycles before accepting the answer as-is.
// Distinct from MAX_ITERATIONS (which caps total tool-call loops).
const MAX_REFLECT_ITERATIONS = 5;
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

    // Cast: guard.ts's RiskModel interface intentionally types `invoke` as
    // (msgs: unknown[]) to stay decoupled from LangChain's BaseChatModel types;
    // reflectorModel satisfies it structurally at runtime (invoke(BaseMessage[])),
    // but the narrower unknown[] param fails strict structural assignability.
    const guardNode = createGuardNode({ riskModel: reflectorModel as any });
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
- If you receive a critique from the Reflector, address each identified issue specifically — do not restate the original answer unchanged.
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
        const result = await toolNode.invoke(state);
        console.log(`⚙️ [FAST TOOLS] Execution complete. Result messages: ${result.messages?.length || 0}`);

        const newToolResults: ToolResultEntry[] = [];
        if (result.messages) {
            for (const msg of result.messages) {
                if (msg._getType() === 'tool') {
                    const rawContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                    const isError = rawContent.toLowerCase().includes('error') || rawContent.toLowerCase().includes('exception');
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

    // ---------------------------------------------------------------------------
    // REFLECTOR NODE
    // ---------------------------------------------------------------------------
    async function reflectNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, toolResults } = state;
        const lastMessage = messages[messages.length - 1];

        // Build tool execution summary from the CURRENT iteration only (not stale prior iterations)
        const currentIterationResults = toolResults?.filter(tr => tr.iterationIndex === state.iterationCount) ?? [];
        let toolExecutionLog = '';
        if (currentIterationResults.length > 0) {
            const entries = currentIterationResults.map(tr =>
                `- ${tr.toolName}: ${tr.isError ? 'ERROR' : 'OK'}\n  Output: ${tr.output}`
            ).join('\n');
            toolExecutionLog = `\n<TOOL_EXECUTION_LOG>\nThe following tools were executed:\n${entries}\n</TOOL_EXECUTION_LOG>\n`;
        }

        // If only tool calls, skip reflection (need an answer to reflect on)
        if ((lastMessage as AIMessage).tool_calls && ((lastMessage as AIMessage).tool_calls?.length ?? 0) > 0) {
            return {};
        }

        console.log(`\n================================================================================`);
        console.log(`🤔 [FAST REFLECTOR] Critiquing response`);
        console.log(`================================================================================\n`);

        const skillCritiqueContext = skillContent
            ? `The assistant is operating under the "${selectedSkill}" skill. Use the following skill instructions to verify correctness and adherence:\n\n${skillContent}`
            : `The assistant is operating as a general-purpose agentic assistant with no specific skill constraints.`;

        const reflectorPrompt = new SystemMessage(`You are a senior AWS and DevOps engineer performing a strict quality review of an AI assistant's response.

${skillCritiqueContext}

Evaluate the assistant's response on these five dimensions:

1. **Correctness**: Is the answer factually accurate? Are AWS CLI commands syntactically valid and semantically correct for the stated intent? Are resource IDs, service names, and flags correct?

2. **Completeness**: Does the response fully address what the user asked? Are there unstated assumptions, missing steps, or gaps that would leave the user unable to act on the answer?

3. **AWS CLI Quality** (if commands were used or suggested): Does the output use --output json? Is --profile used correctly? Is pagination handled for list/describe operations? Was state verified before any mutation was suggested or executed?

4. **Skill Adherence** (if a skill is active): Does the response comply with the privilege rules, safety constraints, and workflow defined in the skill instructions?

5. **Specificity**: Are findings specific (resource IDs, metric values, account names) or vague and generic? Vague responses are considered incomplete.

If a <TOOL_EXECUTION_LOG> section is present, it contains verified tool calls and their outputs that the assistant executed. Use this as ground truth when evaluating correctness — do not claim the assistant fabricated data if the tool log confirms the data was retrieved.

If the response is correct, complete, and specific — respond with exactly: COMPLETE

If there are issues — list them as concise, actionable critique points for the assistant to fix. Be specific about what is wrong and what the correct approach is. Do not generate the fixed answer yourself — only provide the critique.`);

        // Use the FIRST human message as the original query (not the latest, which may be a critique feedback message)
        const userMessage = messages.find(m => m._getType() === 'human');
        const originalQueryRaw = userMessage ? getStringContent(userMessage.content) : "Unknown query";
        const agentResponseRaw = getStringContent(lastMessage.content);

        // Cap inputs to keep the reflector prompt well within the 200k token limit.
        // ~4 chars ≈ 1 token; 40k chars ≈ 10k tokens leaves ample headroom.
        const MAX_QUERY_CHARS = 10_000;
        const MAX_RESPONSE_CHARS = 40_000;
        const originalQuery = originalQueryRaw.length > MAX_QUERY_CHARS
            ? originalQueryRaw.slice(0, MAX_QUERY_CHARS) + '\n… [truncated for reflection]'
            : originalQueryRaw;
        const agentResponse = agentResponseRaw.length > MAX_RESPONSE_CHARS
            ? agentResponseRaw.slice(0, MAX_RESPONSE_CHARS) + '\n… [truncated for reflection]'
            : agentResponseRaw;

        const critiqueInput = new HumanMessage({
            content: `Here is the interaction to review:

<USER_QUERY>
${originalQuery}
</USER_QUERY>
${toolExecutionLog}
<ASSISTANT_RESPONSE>
${agentResponse}
</ASSISTANT_RESPONSE>

Please provide your critique.`
        });

        let response: Awaited<ReturnType<typeof reflectorModel.invoke>>;
        try {
            response = await reflectorModel.invoke([reflectorPrompt, critiqueInput]);
        } catch (err: any) {
            // If the model still rejects the prompt (e.g. token limit), skip reflection
            // and treat the response as complete rather than crashing the whole request.
            console.warn(`⚠️ [FAST REFLECTOR] Skipping reflection due to model error: ${err?.message ?? err}`);
            return { isComplete: true };
        }
        const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

        if (!content) {
            console.log(`⚠️ [FAST REFLECTOR] Empty content received!`);
            console.log(`   Input Query Length: ${originalQuery.length}`);
            console.log(`   Agent Response Length: ${agentResponse.length}`);
            console.log(`   Raw Response:`, JSON.stringify(response));
        }

        console.log(`   Critique: ${truncateOutput(content, 200)}`);

        if (content.includes("COMPLETE")) {
            // Do NOT add the reflector's message to state — the agent's answer is already there.
            // Adding "COMPLETE" would overwrite the last message and leak to the UI.
            return { isComplete: true };
        }

        // Provide critique as a clearly labelled system-style instruction so the agent
        // understands it is in a revision cycle, not receiving a new user request.
        return {
            messages: [new HumanMessage({
                content: `[REFLECTION FEEDBACK] The following issues were identified in your last response. Please revise your answer to address each point:\n\n${content}`
            })],
            isComplete: false
        };
    }

    // Helper to safely extract string content
    function getStringContent(content: string | any[]): string {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map(c => c.text || JSON.stringify(c)).join('');
        }
        return JSON.stringify(content);
    }

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
## Final Answer (iteration cap reached)

You have reached the maximum number of tool-call iterations, so you can NOT run any more tools.
Using ONLY the information already gathered (below), write a clear, complete answer to the
user's original request.

### Original request
${truncateOutput(originalQuery, 2000)}

### Most recent tool outputs
${toolSummary}

Write a clear, markdown-formatted answer that:
- States the key findings directly — include resource IDs, metrics, and command outputs where available.
- Explicitly calls out anything that could not be verified or completed, and why.
- Ends with concrete, actionable next steps.`);

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
    function shouldContinue(state: ReflectionState): "guard" | "reflect" | "finalize" | "memory_save" {
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

        // Soft cap: if we've exceeded the reflection cycle limit, accept the answer as-is
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

    // ---------------------------------------------------------------------------
    // GRAPH CONSTRUCTION
    // ---------------------------------------------------------------------------
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("memory_recall", memoryRecallNode)
        .addNode("agent", agentNode)
        .addNode("guard", guardNode)
        .addNode("approval_gate", approvalGateNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)
        .addNode("finalize", finalizeNode)
        .addNode("memory_save", memorySaveNode)

        .addEdge(START, "memory_recall")
        .addEdge("memory_recall", "agent")

        .addConditionalEdges("agent", shouldContinue, {
            guard: "guard",
            reflect: "reflect",
            finalize: "finalize",
            memory_save: "memory_save"
        })

        .addConditionalEdges("guard", (state: ReflectionState) => routeAfterGuard(state, autoApprove), {
            approval_gate: "approval_gate",
            tools: "tools"
        })
        .addEdge("approval_gate", "tools")

        .addConditionalEdges("reflect", shouldContinueFromReflect, {
            agent: "agent",
            memory_save: "memory_save"
        })

        .addEdge("tools", "agent")
        .addEdge("finalize", "memory_save")
        .addEdge("memory_save", END);

    return workflow.compile({
        checkpointer,
        ...(store && { store }),
        interruptBefore: ["approval_gate"],
    });
}

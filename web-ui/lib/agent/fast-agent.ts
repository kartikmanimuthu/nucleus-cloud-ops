import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { getSkillContent } from "./skills/skill-loader";
import {
    GraphConfig,
    ReflectionState,
    ToolResultEntry,
    graphState,
    MAX_ITERATIONS,
    truncateOutput,
    getRecentMessages,
    getCheckpointer,
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

// --- FAST GRAPH (Reflection Agent Mode) ---
export async function createFastGraph(config: GraphConfig) {
    const { model: modelId, autoApprove, accounts, accountId, accountName, selectedSkill, mcpServerIds, tenantId } = config;
    const checkpointer = await getCheckpointer();

    // Log skill loading
    if (selectedSkill) {
        const content = getSkillContent(selectedSkill);
        if (content) {
            console.log(`[FastAgent] Loaded skill: ${selectedSkill}`);
        } else {
            console.warn(`[FastAgent] Failed to load skill content for: ${selectedSkill}`);
        }
    }

    // --- Shared prompt fragments (built once, reused across all nodes) ---
    const effectiveSkillSection = buildEffectiveSkillSection(selectedSkill);
    const accountContext = buildAccountContext({ accounts, accountId, accountName });
    const awsCliStandards = buildAwsCliStandards();
    const autoApproveGuidance = buildAutoApproveGuidance(autoApprove);
    const operationalWorkflows = buildOperationalWorkflows();

    // skillContent needed for the reflector's critique context
    const skillContent = selectedSkill ? (getSkillContent(selectedSkill) || '') : '';

    // --- Model Initialization ---
    const { main: model, reflector: reflectorModel } = createAgentModels(modelId);

    // --- Tool Assembly (fast-agent does not use S3 tools) ---
    const tools = await assembleTools({ includeS3Tools: false, mcpServerIds, tenantId });
    const modelWithTools = model.bindTools(tools);
    const toolNode = new ToolNode(tools);

    // ---------------------------------------------------------------------------
    // AGENT NODE
    // ---------------------------------------------------------------------------
    async function agentNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, iterationCount } = state;

        console.log(`\n================================================================================`);
        console.log(`🚀 [FAST AGENT] Generator Iteration ${iterationCount + 1}/${MAX_ITERATIONS}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const baseIdentity = buildBaseIdentity(selectedSkill);

        const systemPrompt = new SystemMessage(`${baseIdentity}
${effectiveSkillSection}
${CORE_PRINCIPLES}
${awsCliStandards}
${autoApproveGuidance}
${operationalWorkflows}
${accountContext}

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

        const response = await modelWithTools.invoke([systemPrompt, ...getRecentMessages(messages, 20)]);

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
            messages: [response],
            iterationCount: iterationCount + 1
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
        const { messages } = state;
        const lastMessage = messages[messages.length - 1];

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

If the response is correct, complete, and specific — respond with exactly: COMPLETE

If there are issues — list them as concise, actionable critique points for the assistant to fix. Be specific about what is wrong and what the correct approach is. Do not generate the fixed answer yourself — only provide the critique.`);

        const userMessage = messages.slice().reverse().find(m => m._getType() === 'human');
        const originalQuery = userMessage ? getStringContent(userMessage.content) : "Unknown query";
        const agentResponse = getStringContent(lastMessage.content);

        const critiqueInput = new HumanMessage({
            content: `Here is the interaction to review:

<USER_QUERY>
${originalQuery}
</USER_QUERY>

<ASSISTANT_RESPONSE>
${agentResponse}
</ASSISTANT_RESPONSE>

Please provide your critique.`
        });

        const response = await reflectorModel.invoke([reflectorPrompt, critiqueInput]);
        const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

        if (!content) {
            console.log(`⚠️ [FAST REFLECTOR] Empty content received!`);
            console.log(`   Input Query Length: ${originalQuery.length}`);
            console.log(`   Agent Response Length: ${agentResponse.length}`);
            console.log(`   Raw Response:`, JSON.stringify(response));
        }

        console.log(`   Critique: ${truncateOutput(content, 200)}`);

        if (content.includes("COMPLETE")) {
            return {
                messages: [response],
                isComplete: true
            };
        }

        return {
            messages: [new HumanMessage({ content: `Critique: ${content}\nPlease update your answer.` })],
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
    // CONDITIONAL EDGES
    // ---------------------------------------------------------------------------
    function shouldContinue(state: ReflectionState): "tools" | "reflect" | "__end__" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;
        const { iterationCount } = state;

        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "tools";
        }

        if (iterationCount >= MAX_ITERATIONS) {
            console.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached. Stopping.`);
            return END;
        }

        return "reflect";
    }

    function shouldContinueFromReflect(state: ReflectionState): "agent" | "__end__" {
        if (state.isComplete) {
            return END;
        }
        return "agent";
    }

    // ---------------------------------------------------------------------------
    // GRAPH CONSTRUCTION
    // ---------------------------------------------------------------------------
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("agent", agentNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)

        .addEdge(START, "agent")

        .addConditionalEdges("agent", shouldContinue, {
            tools: "tools",
            reflect: "reflect",
            __end__: END
        })

        .addConditionalEdges("reflect", shouldContinueFromReflect, {
            agent: "agent",
            __end__: END
        })

        .addEdge("tools", "agent");

    if (autoApprove) {
        return workflow.compile({ checkpointer });
    } else {
        return workflow.compile({
            checkpointer,
            interruptBefore: ["tools"],
        });
    }
}

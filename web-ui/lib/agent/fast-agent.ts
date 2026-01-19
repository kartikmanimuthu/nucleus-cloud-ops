import { BaseMessage, AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, START, END } from "@langchain/langgraph";
import { ChatBedrockConverse } from "@langchain/aws";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
    executeCommandTool,
    readFileTool,
    writeFileTool,
    lsTool,
    editFileTool,
    globTool,
    grepTool,
    webSearchTool,
    getAwsCredentialsTool
} from "./tools";
import {
    GraphConfig,
    ReflectionState,
    graphState,
    MAX_ITERATIONS,
    truncateOutput,
    getRecentMessages,
    checkpointer
} from "./agent-shared";

// --- FAST GRAPH (Reflection Agent Mode) ---
export function createFastGraph(config: GraphConfig) {
    const { model: modelId, autoApprove, accountId, accountName } = config;

    // --- Model Initialization ---
    const model = new ChatBedrockConverse({
        region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
        model: modelId,
        maxTokens: 4096,
        temperature: 0,
        streaming: true,
    });

    // Include AWS credentials tool for account-aware operations
    // Include AWS credentials tool for account-aware operations
    const tools = [executeCommandTool, readFileTool, writeFileTool, lsTool, editFileTool, globTool, grepTool, webSearchTool, getAwsCredentialsTool];
    const modelWithTools = model.bindTools(tools);
    const toolNode = new ToolNode(tools);

    // Build account context string for prompts
    const accountContext = accountId
        ? `\n\nIMPORTANT - AWS ACCOUNT CONTEXT:\nYou are operating in the context of AWS account: ${accountName || accountId} (ID: ${accountId}).\nBefore executing any AWS CLI commands, you MUST first call the get_aws_credentials tool with accountId="${accountId}" to create a session profile.\nThe tool will return a profile name. Use this profile with ALL subsequent AWS CLI commands by adding: --profile <profileName>\nExample: aws sts get-caller-identity --profile <profileName>\nNEVER use the host's default credentials - always use the profile returned from get_aws_credentials.`
        : `\n\nNOTE: No AWS account is selected. If the user asks to perform AWS operations, inform them that they need to select an AWS account first.`;

    // --- GENERATOR NODE (Agent) ---
    async function agentNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, iterationCount } = state;

        console.log(`\n================================================================================`);
        console.log(`🚀 [FAST AGENT] Generator Iteration ${iterationCount + 1}/${MAX_ITERATIONS}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const systemPrompt = new SystemMessage(`You are a capable DevOps and Cloud Infrastructure assistant.
You have access to tools: read_file, write_file, edit_file, ls, glob, grep, execute_command, web_search, get_aws_credentials.
You are proficient with AWS CLI, git, shell scripting, and infrastructure management.

IMPORTANT: You are a READ-ONLY agent.
- You MUST NOT perform any mutation operations (create, update, delete resources).
- You MUST NOT execute dangerous commands (rm, mv, etc).
- Your AWS IAM role is read-only.
- If asked to perform a mutation, politely refuse and explain your read-only limitations.

${accountContext}

Answer the user's request directly.
If you receive a critique from the Reflector, update your previous answer to address the critique.
Be concise and effective.`);

        // Filter messages to get a valid context window
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

    // Custom tool node that collects results (Added for logging parity)
    async function collectingToolNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        console.log(`\n⚙️ [FAST TOOLS] Executing tool calls...`);
        const result = await toolNode.invoke(state);
        console.log(`⚙️ [FAST TOOLS] Execution complete. Result messages: ${result.messages?.length || 0}`);

        if (result.messages) {
            for (const msg of result.messages) {
                if (msg._getType() === 'tool') {
                    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                    console.log(`   ✅ [TOOL RESULT] ${msg.name || 'Unknown Tool'}:`);
                    console.log(`      ${truncateOutput(content, 200).replace(/\n/g, '\n      ')}`);
                }
            }
        }
        return result;
    }

    // --- REFLECTOR NODE ---
    async function reflectNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages } = state;
        const lastMessage = messages[messages.length - 1];

        // If only tool calls, skip reflection (we need an answer to reflect on)
        if ((lastMessage as AIMessage).tool_calls && ((lastMessage as AIMessage).tool_calls?.length ?? 0) > 0) {
            return {};
        }

        console.log(`\n================================================================================`);
        console.log(`🤔 [FAST REFECTOR] Critiquing response`);
        console.log(`================================================================================\n`);

        const reflectorPrompt = new SystemMessage(`You are a strict critic reviewing an AI assistant's response.
Analyze the response for:
1. Correctness
2. Completeness (did it answer the user's request?)
3. Missing details
4. SECURITY: Ensure the assistant acted as a READ-ONLY agent. If it performed any mutation/write/delete operations, flag this as a major error.

If the response is good and complete, respond with "COMPLETE".
If there are issues, list them clearly and concisely as feedback for the assistant to fix.
Do not generate the fixed answer yourself, just the analysis.`);

        // Construct a clean context for the Reflector to avoid Bedrock tool validation issues
        // and to prevent the Reflector from trying to use tools itself.
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

        // Use the base 'model' (no tools bound) to ensure strict text generation
        const response = await model.invoke([reflectorPrompt, critiqueInput]);
        const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

        if (!content) {
            console.log(`⚠️ [FAST REFECTOR] Empty content received!`);
            console.log(`   Input Query Length: ${originalQuery.length}`);
            console.log(`   Agent Response Length: ${agentResponse.length}`);
            console.log(`   Raw Response:`, JSON.stringify(response));
        }

        console.log(`   Critique: ${truncateOutput(content, 200)}`);

        if (content.includes("COMPLETE")) {
            // We're done. Return the critique message so it's visible, and mark complete.
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

    // --- CONDITIONAL EDGES ---
    function shouldContinue(state: ReflectionState): "tools" | "reflect" | "__end__" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;
        const { iterationCount } = state;

        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "tools";
        }

        // If we have text, we reflect
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

    // --- GRAPH CONSTRUCTION ---
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

import { BaseMessage, AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
import { StateGraph, StateGraphArgs, START, END } from "@langchain/langgraph";
import { ChatBedrockConverse } from "@langchain/aws";
import {
    executeCommandTool,
    readFileTool,
    writeFileTool,
    listDirectoryTool,
    webSearchTool
} from "./tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";

// --- State Definition ---
import { FileSaver } from "./file-saver";
// import { DynamoDBSaver } from "./dynamo-saver"; // Removed
import { DynamoDBSaver } from "@rwai/langgraphjs-checkpoint-dynamodb";
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

// --- State Definition ---
// Shared checkpointer for the session (backed by file system or DynamoDB)
// Usage of globalThis ensures the checkpointer survives Next.js hot reloads in dev mode
const globalForCheckpointer = globalThis as unknown as { checkpointer: BaseCheckpointSaver };

function getCheckpointer() {
    if (globalForCheckpointer.checkpointer) return globalForCheckpointer.checkpointer;

    if (process.env.DYNAMODB_CHECKPOINT_TABLE && process.env.DYNAMODB_WRITES_TABLE) {
        console.log("Using DynamoDB Checkpointer with tables:", process.env.DYNAMODB_CHECKPOINT_TABLE, process.env.DYNAMODB_WRITES_TABLE);
        return new DynamoDBSaver({
            clientConfig: {
                region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null'
            },
            checkpointsTableName: process.env.DYNAMODB_CHECKPOINT_TABLE,
            writesTableName: process.env.DYNAMODB_WRITES_TABLE
        });
    }

    console.log("Using FileSystem Checkpointer");
    return new FileSaver();
}

const checkpointer = getCheckpointer();
if (process.env.NODE_ENV !== "production") globalForCheckpointer.checkpointer = checkpointer;

export interface PlanStep {
    step: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

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
    toolResults: string[]; // Store tool results for final summary
}

// --- Schema for StateGraph ---
const graphState: StateGraphArgs<ReflectionState>["channels"] = {
    messages: {
        reducer: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
    },
    taskDescription: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
    plan: {
        reducer: (x: PlanStep[], y: PlanStep[]) => y.length > 0 ? y : x,
        default: () => [],
    },
    code: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
    executionOutput: {
        reducer: (x: string, y: string) => y ? (x + "\n" + y) : x, // Accumulate outputs
        default: () => "",
    },
    errors: {
        reducer: (x: string[], y: string[]) => y.length > 0 ? y : x,
        default: () => [],
    },
    reflection: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
    iterationCount: {
        reducer: (x: number, y: number) => y,
        default: () => 0,
    },
    nextAction: {
        reducer: (x: string, y: string) => y || x,
        default: () => "plan",
    },
    isComplete: {
        reducer: (x: boolean, y: boolean) => y,
        default: () => false,
    },
    toolResults: {
        reducer: (x: string[], y: string[]) => x.concat(y),
        default: () => [],
    },
};

// --- Constants ---
const MAX_ITERATIONS = 30;

// --- Helper Functions ---
function truncateOutput(text: string, maxChars: number = 500): string {
    if (!text) return "";
    if (text.length > maxChars) {
        return text.slice(0, maxChars) + "...";
    }
    return text;
}

// Get recent messages safely - ensuring tool call/result pairs are kept together
// Also filters out empty messages that cause Bedrock API errors
function getRecentMessages(messages: BaseMessage[], maxMessages: number = 8): BaseMessage[] {
    // First, filter out messages with empty content (but keep AIMessages with tool_calls)
    const validMessages = messages.filter(msg => {
        const content = msg.content;
        // AIMessages with tool_calls are valid even with empty content
        if (msg._getType() === 'ai' && 'tool_calls' in msg) {
            const aiMsg = msg as AIMessage;
            if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) return true;
        }
        // Filter out empty content
        if (!content) return false;
        if (typeof content === 'string' && content.trim() === '') return false;
        if (Array.isArray(content) && content.length === 0) return false;
        return true;
    });

    if (validMessages.length === 0) return [];

    let result: BaseMessage[] = [];
    const firstMsg = validMessages[0];

    // Build a proper subset that maintains tool_call/tool_result pairing
    // Strategy: Start from the end and work backwards, always including complete tool call groups
    let i = validMessages.length - 1;

    // If fewer messages than max, just take them all
    if (validMessages.length <= maxMessages) {
        result = [...validMessages];
    } else {
        // Collect from tail
        while (i >= 0 && result.length < maxMessages * 2) {
            const msg = validMessages[i];

            if (msg._getType() === 'tool') {
                // Found a ToolMessage - we need to find ALL tool messages in this batch
                const toolBatch: BaseMessage[] = [msg];
                let j = i - 1;

                while (j >= 0 && validMessages[j]._getType() === 'tool') {
                    toolBatch.unshift(validMessages[j]);
                    j--;
                }

                if (j >= 0 && validMessages[j]._getType() === 'ai') {
                    const aiMsg = validMessages[j] as AIMessage;
                    if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
                        result.unshift(...toolBatch);
                        result.unshift(validMessages[j]);
                        i = j - 1;
                    } else { i = j; }
                } else { i = j; }
            } else {
                result.unshift(msg);
                i--;
            }
        }
    }

    // Trim to maxMessages but respect tool groups (simple trim might break pairs, so we trust reasonable length)
    // If strict length needed:
    if (result.length > maxMessages) {
        // This simple slice is risky for tools, but usually OK if maxMessages is high enough (10-12)
        // Better to rely on "maxMessages * 2" buffer above or accept slightly longer context
        // For now, we prioritize correctness of pairs over exact count
    }

    // 1. Ensure conversation starts with the first User message (Task)
    if (result.length > 0 && result[0] !== firstMsg) {
        // Remove orphans if any
        while (result.length > 0 && result[0]._getType() === 'tool') {
            result.shift();
        }
        // Prepend first message
        if (result.length === 0 || result[0] !== firstMsg) {
            result.unshift(firstMsg);
        }
    } else if (result.length === 0) {
        result.push(firstMsg);
    }

    // 2. Formatting for Bedrock/Nova: Ensure strictly alternating Human/AI roles
    // We iterate and insert "Proceed" messages if we see AI -> AI
    const formattedResult: BaseMessage[] = [];
    if (result.length > 0) formattedResult.push(result[0]); // Push first (User)

    for (let k = 1; k < result.length; k++) {
        const prev = formattedResult[formattedResult.length - 1];
        const curr = result[k];

        // Fix: AI -> AI (Insert Human)
        if (prev._getType() === 'ai' && curr._getType() === 'ai') {
            formattedResult.push(new HumanMessage({ content: "Proceed." }));
        }

        // Fix: User -> User (Insert AI ack)
        if (prev._getType() === 'human' && curr._getType() === 'human') {
            formattedResult.push(new AIMessage({ content: "Acknowledged." }));
        }

        formattedResult.push(curr);
    }

    // Final sanity check: Must start with Human (which firstMsg is)
    // But if firstMsg was somehow AI (should not happen if validMessages[0] is User), we fix.
    if (formattedResult.length > 0 && formattedResult[0]._getType() === 'ai') {
        formattedResult.unshift(new HumanMessage({ content: "Start session." }));
    }

    return formattedResult;
}

// Configuration for graph creation
export interface GraphConfig {
    model: string;
    autoApprove: boolean;
}

// Factory function to create a configured reflection graph
export function createReflectionGraph(config: GraphConfig) {
    const { model: modelId, autoApprove } = config;

    // --- Model Initialization ---
    const model = new ChatBedrockConverse({
        region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
        model: modelId,
        maxTokens: 4096,
        temperature: 0,
        streaming: true,
    });

    const tools = [executeCommandTool, readFileTool, writeFileTool, listDirectoryTool, webSearchTool];
    const modelWithTools = model.bindTools(tools);
    const toolNode = new ToolNode(tools);

    // --- PLANNER NODE ---
    async function planNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages } = state;
        const lastMessage = messages[messages.length - 1];
        const taskDescription = typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);

        console.log(`\n================================================================================`);
        console.log(`🤖 [PLANNER] Initiating planning phase`);
        console.log(`   Task: "${truncateOutput(taskDescription, 100)}"`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const plannerSystemPrompt = new SystemMessage(`You are a development planning agent.
Given a task, create a clear step-by-step plan to accomplish it.
Focus on actionable steps that can be executed using available tools:
- read_file: Read content from a file
- write_file: Write content to a file  
- list_directory: List contents of a directory
- execute_command: Execute shell commands
- web_search: Search the web for information

Be specific and practical. Each step should be executable.

IMPORTANT: Return your plan as a JSON array of step descriptions.
Example: ["Step 1: List directory contents", "Step 2: Read config file", "Step 3: Execute tests"]

Only return the JSON array, nothing else.`);

        const response = await model.invoke([plannerSystemPrompt, lastMessage]);

        let planSteps: PlanStep[] = [];
        try {
            const content = response.content as string;
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                planSteps = parsed.map((step: string) => ({
                    step,
                    status: 'pending' as const
                }));
            }
        } catch (e) {
            console.error("[Planner] Plan parsing failed:", e);
            planSteps = [{
                step: "Analyze and respond to user request",
                status: 'pending' as const
            }];
        }

        if (planSteps.length === 0) {
            planSteps = [{
                step: "Analyze and respond to user request",
                status: 'pending' as const
            }];
        }

        const planText = planSteps.map((s, i) => `${i + 1}. ${s.step}`).join('\n');
        console.log(`\n📋 [PLANNER] Plan Generated:`);
        console.log(`--------------------------------------------------------------------------------`);
        console.log(planText);
        console.log(`--------------------------------------------------------------------------------\n`);

        return {
            plan: planSteps,
            taskDescription,
            messages: [new AIMessage({ content: `📋 **Plan Created:**\n${planText}` })],
            nextAction: "generate"
        };
    }

    // --- GENERATOR NODE ---
    async function generateNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, plan, iterationCount } = state;

        console.log(`\n================================================================================`);
        console.log(`⚡ [EXECUTOR] Iteration ${iterationCount + 1}/${MAX_ITERATIONS}`);
        console.log(`   Current Step: ${plan.find(s => s.status === 'pending')?.step || 'Executing...'}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const pendingSteps = plan.filter(s => s.status === 'pending' || s.status === 'in_progress');
        const currentStep = pendingSteps[0]?.step || "Complete the task";

        const executorSystemPrompt = new SystemMessage(`You are an expert code executor agent.
Based on the plan, execute the current step using available tools.

Current Step: ${currentStep}
Full Plan: ${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}

Available tools:
- read_file(file_path): Read content from a file
- write_file(file_path, content): Write content to a file (creates directories if needed)
- list_directory(path): List contents of a directory
- execute_command(command): Execute a shell command
- web_search(query): Search the web for information

IMPORTANT: You should use tools to accomplish the task if necessary. If the task is a simple question or greeting that doesn't require tools, you may answer directly.
After using tools (or if no tools are needed), provide a brief summary of what you accomplished or the answer.`);

        const response = await modelWithTools.invoke([executorSystemPrompt, ...getRecentMessages(messages, 10)]);

        if ('tool_calls' in response && response.tool_calls && response.tool_calls.length > 0) {
            console.log(`\n🛠️ [EXECUTOR] Tool Calls Generated:`);
            for (const toolCall of response.tool_calls) {
                console.log(`   → Tool: ${toolCall.name}`);
                console.log(`     Args: ${JSON.stringify(toolCall.args)}`);
            }
        } else {
            console.log(`\n💬 [EXECUTOR] No tools called. Generating text response.`);
        }

        return {
            messages: [response],
            iterationCount: iterationCount + 1
        };
    }

    // Custom tool node that collects results
    async function collectingToolNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        console.log(`\n⚙️ [TOOLS] Executing tool calls...`);
        const result = await toolNode.invoke(state);
        console.log(`⚙️ [TOOLS] Execution complete. Result messages: ${result.messages?.length || 0}`);

        // Extract tool results for final summary
        const newToolResults: string[] = [];
        if (result.messages) {
            for (const msg of result.messages) {
                if (msg._getType() === 'tool') {
                    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                    const truncated = truncateOutput(content, 1000);
                    newToolResults.push(truncated);
                    console.log(`   ✅ [TOOL RESULT] ${msg.name || 'Unknown Tool'}:`);
                    console.log(`      ${truncateOutput(content, 200).replace(/\n/g, '\n      ')}`);
                }
            }
        }

        return {
            ...result,
            toolResults: newToolResults,
            executionOutput: newToolResults.join('\n---\n')
        };
    }

    // --- REFLECTOR NODE ---
    async function reflectNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, taskDescription, iterationCount, plan, toolResults } = state;

        console.log(`\n================================================================================`);
        console.log(`🤔 [REFLECTOR] Analyzing execution results`);
        console.log(`   Iteration: ${iterationCount}/${MAX_ITERATIONS}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================`);

        const reflectorSystemPrompt = new SystemMessage(`You are a quality assurance agent reviewing development work.

Original Task: ${taskDescription}

Current Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}

Current Iteration: ${iterationCount}/${MAX_ITERATIONS}

Tool Execution Results Summary:
${toolResults.slice(-5).join('\n---\n')}

Review the conversation history and tool outputs. Provide your analysis in the following JSON format:
{
    "analysis": "Brief analysis of what was done and the results",
    "issues": "Any issues or errors found, or 'None' if no issues",
    "suggestions": "Suggestions for improvement, or 'None' if no suggestions",
    "isComplete": true or false
}

Be specific and actionable in your feedback.
Only return the JSON object, nothing else.`);

        const response = await modelWithTools.invoke([reflectorSystemPrompt, ...getRecentMessages(messages, 12)]);

        let analysis = "";
        let issues = "None";
        let suggestions = "None";
        let isComplete = false;

        try {
            const content = response.content as string;
            // Log raw content for debugging
            console.log(`[Reflector] Raw content: ${truncateOutput(content, 200)}`);

            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                analysis = parsed.analysis || "";
                issues = parsed.issues || "None";
                suggestions = parsed.suggestions || "None";
                isComplete = parsed.isComplete === true;
            } else {
                console.log("[Reflector] No JSON found, using raw content fallback");
                analysis = content;
                // Simple heuristic for completion if model doesn't follow JSON format
                if (content.toLowerCase().includes("task complete") || content.toLowerCase().includes("no issues") || issues === "None") {
                    isComplete = true; // Optimistic completion if it looks good
                }
            }

            // Fallback for empty content or "None" issues even if parsed
            if (issues === "None" && !isComplete) {
                // Double check if analysis implies completion
                isComplete = true;
            }
        } catch (e) {
            console.error("[Reflector] Parsing failed:", e);
            analysis = "Completed current iteration (Parsing Error)";
            isComplete = iterationCount >= MAX_ITERATIONS;
        }

        console.log(`\n🧐 [REFLECTOR] Analysis Complete:`);
        console.log(`   Analysis:    ${truncateOutput(analysis, 300)}`);
        console.log(`   Issues:      ${issues !== "None" ? '❌ ' + issues : '✅ None'}`);
        console.log(`   Suggestions: ${suggestions !== "None" ? '💡 ' + suggestions : 'None'}`);
        console.log(`   Status:      ${isComplete ? '✅ COMPLETE' : '🔄 CONTINUING'}`);
        console.log(`--------------------------------------------------------------------------------\n`);

        const feedback = `🔍 **Reflection Analysis:**
${analysis}

${issues !== "None" ? `⚠️ **Issues Found:** ${issues}` : ""}
${suggestions !== "None" ? `💡 **Suggestions:** ${suggestions}` : ""}

**Task Complete:** ${isComplete ? "✅ Yes" : "❌ No, continuing..."}`;

        if (iterationCount >= MAX_ITERATIONS && !isComplete) {
            console.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached. Forcing completion.`);
            isComplete = true;
        }

        return {
            messages: [new AIMessage({ content: feedback })],
            reflection: analysis,
            errors: issues !== "None" ? [issues] : [],
            isComplete,
            nextAction: isComplete ? "complete" : "revise"
        };
    }

    // --- REVISER NODE ---
    async function reviseNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, reflection, errors } = state;

        console.log(`\n================================================================================`);
        console.log(`📝 [REVISER] Applying fixes and improvements`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const reviserSystemPrompt = new SystemMessage(`You are a code revision agent.
Based on the feedback provided, make improvements to address the issues.

Recent Feedback: ${reflection}
Issues to Address: ${errors.join(', ') || 'None'}

Use the available tools to fix problems and improve the solution.
Focus on addressing the specific issues mentioned in the feedback.

Available tools:
- read_file, write_file, list_directory, execute_command, web_search`);

        const response = await modelWithTools.invoke([reviserSystemPrompt, ...getRecentMessages(messages, 10)]);

        if ('tool_calls' in response && response.tool_calls && response.tool_calls.length > 0) {
            console.log(`\n🛠️ [REVISER] Tool Calls Generated:`);
            for (const toolCall of response.tool_calls) {
                console.log(`   → Tool: ${toolCall.name}`);
            }
        }

        return {
            messages: [response],
            nextAction: "generate"
        };
    }

    // --- FINAL OUTPUT NODE --- (Improved to provide comprehensive summary)
    async function finalNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { taskDescription, iterationCount, reflection, toolResults, messages, plan } = state;

        console.log(`\n================================================================================`);
        console.log(`🏁 [FINAL] Generating comprehensive summary`);
        console.log(`================================================================================\n`);

        // Create a summary prompt to generate user-friendly final output
        const summarySystemPrompt = new SystemMessage(`You are a helpful assistant summarizing the results of a completed task.

Original Task: ${taskDescription}

Execution Summary:
- Total Iterations: ${iterationCount}
- Plan Steps: ${plan.map(s => `${s.step} (${s.status})`).join(', ')}

Tool Execution Results (most recent):
${toolResults.slice(-3).map(r => truncateOutput(r, 500)).join('\n\n')}

Final Reflection: ${reflection}

Based on the above, provide a clear, helpful summary for the user that:
1. States what was accomplished
2. Highlights key findings or results
3. Notes any important information from tool outputs
4. Suggests next steps if applicable

Be concise but comprehensive. Format nicely with markdown.`);

        // Use modelWithTools since messages contain tool content
        const summaryResponse = await modelWithTools.invoke([summarySystemPrompt, ...getRecentMessages(messages, 5)]);
        const summaryContent = typeof summaryResponse.content === 'string'
            ? summaryResponse.content
            : JSON.stringify(summaryResponse.content);

        const finalMessage = `✅ **Task Complete**

**Original Task:** ${taskDescription}

**Iterations Used:** ${iterationCount}

---

${summaryContent}`;

        console.log(`--- FINAL: Summary generated ---`);

        return {
            messages: [new AIMessage({ content: finalMessage })],
            isComplete: true
        };
    }

    // --- CONDITIONAL EDGES ---
    function shouldContinueFromGenerate(state: ReflectionState): "tools" | "reflect" | "final" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;

        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "tools";
        }

        // Optimization: For simple requests (first iteration, no tools), skip reflection to speed up response
        // This helps avoid 504 Gateway Timeouts on non-streaming responses.
        const { iterationCount } = state;
        if (iterationCount <= 1) {
            console.log("⚡ [Fast Path] First iteration with no tools. Skipping reflection.");
            return "final";
        }

        return "reflect";
    }

    function shouldContinueFromTools(state: ReflectionState): "generate" | "reflect" {
        const { iterationCount } = state;

        if (iterationCount >= MAX_ITERATIONS) {
            console.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached after tools. Forcing reflection.`);
            return "reflect";
        }
        return "generate";
    }

    function shouldContinueFromRevise(state: ReflectionState): "tools" | "reflect" {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as AIMessage;

        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "tools";
        }
        return "reflect";
    }

    function shouldContinueFromReflect(state: ReflectionState): "revise" | "final" {
        const { isComplete, iterationCount } = state;

        if (isComplete || iterationCount >= MAX_ITERATIONS) {
            return "final";
        }
        return "revise";
    }

    // --- GRAPH CONSTRUCTION ---
    const workflow = new StateGraph<ReflectionState>({ channels: graphState })
        .addNode("planner", planNode)
        .addNode("generate", generateNode)
        .addNode("tools", collectingToolNode)
        .addNode("reflect", reflectNode)
        .addNode("revise", reviseNode)
        .addNode("final", finalNode)

        .addEdge(START, "planner")
        .addEdge("planner", "generate")

        .addConditionalEdges("generate", shouldContinueFromGenerate, {
            tools: "tools",
            reflect: "reflect",
            final: "final" // Added fast path
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

        .addEdge("final", END);

    // Compile with or without interrupt based on autoApprove setting
    if (autoApprove) {
        console.log(`[Graph] Creating graph with autoApprove=true (no interrupts)`);
        return workflow.compile({ checkpointer });
    } else {
        console.log(`[Graph] Creating graph with autoApprove=false (interrupt before tools)`);
        return workflow.compile({
            checkpointer,
            interruptBefore: ["tools"],
        });
    }
}

// --- FAST GRAPH (Reflection Agent Mode) ---
export function createFastGraph(config: GraphConfig) {
    const { model: modelId, autoApprove } = config;

    // --- Model Initialization ---
    const model = new ChatBedrockConverse({
        region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null',
        model: modelId,
        maxTokens: 4096,
        temperature: 0,
        streaming: true,
    });

    const tools = [executeCommandTool, readFileTool, writeFileTool, listDirectoryTool, webSearchTool];
    const modelWithTools = model.bindTools(tools);
    const toolNode = new ToolNode(tools);

    // --- GENERATOR NODE (Agent) ---
    async function agentNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const { messages, iterationCount } = state;

        console.log(`\n================================================================================`);
        console.log(`🚀 [FAST AGENT] Generator Iteration ${iterationCount + 1}/${MAX_ITERATIONS}`);
        console.log(`   Model: ${modelId}`);
        console.log(`================================================================================\n`);

        const systemPrompt = new SystemMessage(`You are a capable AI assistant.
You have access to tools: read_file, write_file, list_directory, execute_command, web_search.

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
        if ((lastMessage as AIMessage).tool_calls && (lastMessage as AIMessage).tool_calls?.length > 0) {
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

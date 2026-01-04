import { BaseMessage, AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
import { StateGraph, StateGraphArgs, START, END, MemorySaver } from "@langchain/langgraph";
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
        reducer: (x: string, y: string) => y || x,
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
};

// --- Model Initialization ---
// NOTE: This is a static model initialization. For the dynamic model selection used in the API, 
// see 'lib/agent/graph-factory.ts' which behaves similarly but allows the model to be injected.
// The API route (/api/chat) uses the factory, not this static instance.
const model = new ChatBedrockConverse({
    region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || "Null",
    // model: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    maxTokens: 4096,
    temperature: 0,
    streaming: true,
});

const tools = [executeCommandTool, readFileTool, writeFileTool, listDirectoryTool, webSearchTool];
const modelWithTools = model.bindTools(tools);
const toolNode = new ToolNode(tools);

// --- Constants ---
const MAX_ITERATIONS = 5;

// --- Helper Functions ---
function truncateOutput(text: string, maxChars: number = 500): string {
    if (!text) return "";
    if (text.length > maxChars) {
        return text.slice(0, maxChars) + "...";
    }
    return text;
}

// Get recent messages safely - ensuring tool call/result pairs are kept together
function getRecentMessages(messages: BaseMessage[], maxMessages: number = 8): BaseMessage[] {
    if (messages.length <= maxMessages) {
        return messages;
    }

    // Start from the end and work backwards
    const result: BaseMessage[] = [];
    let i = messages.length - 1;

    while (i >= 0 && result.length < maxMessages) {
        const msg = messages[i];

        // Check if this message is part of a tool interaction
        // If it's a ToolMessage, we need to include the preceding AIMessage with tool_calls
        if (msg._getType() === 'tool') {
            result.unshift(msg);
            // Look for the AIMessage that initiated this tool call
            let j = i - 1;
            while (j >= 0) {
                const prevMsg = messages[j];
                if (prevMsg._getType() === 'ai' && 'tool_calls' in prevMsg &&
                    (prevMsg as AIMessage).tool_calls && (prevMsg as AIMessage).tool_calls!.length > 0) {
                    result.unshift(prevMsg);
                    i = j - 1;
                    break;
                } else if (prevMsg._getType() === 'tool') {
                    // Continue looking, there might be a batch of tool messages
                    result.unshift(prevMsg);
                    j--;
                } else {
                    break;
                }
            }
            if (j < 0) i = j;
        } else {
            result.unshift(msg);
            i--;
        }
    }

    return result;
}

// --- PLANNER NODE ---
async function planNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
    const { messages } = state;
    const lastMessage = messages[messages.length - 1];
    const taskDescription = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);

    console.log(`\n--- PLANNER: Creating plan for: ${truncateOutput(taskDescription, 100)} ---`);

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
    console.log(`--- PLANNER: Plan created ---`);
    console.log(planText);

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

    console.log(`\n--- EXECUTOR: Working on task (iteration ${iterationCount + 1}) ---`);

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

IMPORTANT: You MUST use tools to accomplish the task. Do not just describe what you would do.
After using tools, provide a brief summary of what you accomplished.`);

    const response = await modelWithTools.invoke([executorSystemPrompt, ...getRecentMessages(messages, 10)]);

    // Log tool calls if any
    if ('tool_calls' in response && response.tool_calls && response.tool_calls.length > 0) {
        for (const toolCall of response.tool_calls) {
            console.log(`💭 EXECUTOR: Using tool '${toolCall.name}'`);
        }
    }

    return {
        messages: [response],
        iterationCount: iterationCount + 1
    };
}

// --- REFLECTOR NODE ---
async function reflectNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
    const { messages, taskDescription, iterationCount, plan } = state;

    console.log(`\n--- REFLECTOR: Analyzing execution results ---`);

    const reflectorSystemPrompt = new SystemMessage(`You are a quality assurance agent reviewing development work.

Original Task: ${taskDescription}

Current Plan Status:
${plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')}

Current Iteration: ${iterationCount}/${MAX_ITERATIONS}

Review the conversation history and tool outputs. Provide your analysis in the following JSON format:
{
    "analysis": "Brief analysis of what was done and the results",
    "issues": "Any issues or errors found, or 'None' if no issues",
    "suggestions": "Suggestions for improvement, or 'None' if no suggestions",
    "isComplete": true or false
}

Be specific and actionable in your feedback.
Only return the JSON object, nothing else.`);

    // Use modelWithTools since messages may contain tool content
    const response = await modelWithTools.invoke([reflectorSystemPrompt, ...getRecentMessages(messages, 12)]);

    let analysis = "";
    let issues = "None";
    let suggestions = "None";
    let isComplete = false;

    try {
        const content = response.content as string;
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            analysis = parsed.analysis || "";
            issues = parsed.issues || "None";
            suggestions = parsed.suggestions || "None";
            isComplete = parsed.isComplete === true;
        }
    } catch (e) {
        console.error("[Reflector] Parsing failed:", e);
        analysis = "Completed current iteration";
        isComplete = iterationCount >= MAX_ITERATIONS;
    }

    console.log(`--- REFLECTOR: Analysis complete ---`);
    console.log(`  Analysis: ${truncateOutput(analysis, 300)}`);
    if (issues !== "None") console.log(`  Issues: ${truncateOutput(issues, 200)}`);
    if (suggestions !== "None") console.log(`  Suggestions: ${truncateOutput(suggestions, 200)}`);
    console.log(`  Task Complete: ${isComplete}`);

    const feedback = `🔍 **Reflection Analysis:**
${analysis}

${issues !== "None" ? `⚠️ **Issues Found:** ${issues}` : ""}
${suggestions !== "None" ? `💡 **Suggestions:** ${suggestions}` : ""}

**Task Complete:** ${isComplete ? "✅ Yes" : "❌ No, continuing..."}`;

    // Force complete if max iterations reached
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

    console.log(`\n--- REVISER: Addressing feedback and making improvements ---`);

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
        for (const toolCall of response.tool_calls) {
            console.log(`💭 REVISER: Using tool '${toolCall.name}' to fix issues`);
        }
    }

    return {
        messages: [response],
        nextAction: "generate"
    };
}

// --- FINAL OUTPUT NODE ---
async function finalNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
    const { taskDescription, iterationCount, reflection } = state;

    console.log(`\n--- FINAL: Task execution complete ---`);

    const summary = `✅ **Task Complete**

**Original Task:** ${taskDescription}

**Iterations:** ${iterationCount}

**Final Assessment:** ${reflection || "Task completed successfully"}`;

    console.log(summary);

    return {
        messages: [new AIMessage({ content: summary })],
        isComplete: true
    };
}

// --- CONDITIONAL EDGES ---
function shouldContinueFromGenerate(state: ReflectionState): "tools" | "reflect" {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1] as AIMessage;

    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
        return "tools";
    }
    return "reflect";
}

// After tools, check if we should continue or force reflection
function shouldContinueFromTools(state: ReflectionState): "generate" | "reflect" {
    const { iterationCount } = state;

    // Force reflection after MAX_ITERATIONS to prevent infinite loops
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
    .addNode("tools", toolNode)
    .addNode("reflect", reflectNode)
    .addNode("revise", reviseNode)
    .addNode("final", finalNode)

    // Entry point
    .addEdge(START, "planner")
    .addEdge("planner", "generate")

    // Generate can go to tools or reflect
    .addConditionalEdges("generate", shouldContinueFromGenerate, {
        tools: "tools",
        reflect: "reflect"
    })

    // After tools, check iteration limit then go to generate or force reflect
    .addConditionalEdges("tools", shouldContinueFromTools, {
        generate: "generate",
        reflect: "reflect"
    })

    // Reflect decides: revise or finish
    .addConditionalEdges("reflect", shouldContinueFromReflect, {
        revise: "revise",
        final: "final"
    })

    // Revise can use tools or go to reflect
    .addConditionalEdges("revise", shouldContinueFromRevise, {
        tools: "tools",
        reflect: "reflect"
    })

    // Final goes to END
    .addEdge("final", END);

// --- Checkpointer for persistence ---
const checkpointer = new MemorySaver();

export const reflectionGraph = workflow.compile({
    checkpointer,
    // Note: Removed interruptBefore to allow continuous execution
    // Human-in-the-loop can be added later with proper Vercel AI SDK tool approval integration
});

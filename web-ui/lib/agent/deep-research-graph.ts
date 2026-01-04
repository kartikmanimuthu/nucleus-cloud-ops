import { BaseMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, StateGraphArgs, START, END, MemorySaver } from "@langchain/langgraph";
import { ChatBedrockConverse } from "@langchain/aws";
import { executeCommandTool } from "./tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";

// --- State Definition ---
interface AgentState {
    messages: BaseMessage[];
    plan: string[];
    currentStepIndex: number;
    researchResults: string[];
}

// --- Schema for StateGraph ---
const graphState: StateGraphArgs<AgentState>["channels"] = {
    messages: {
        reducer: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
    },
    plan: {
        reducer: (x: string[], y: string[]) => y, // Always replace with latest plan
        default: () => [],
    },
    currentStepIndex: {
        reducer: (x: number, y: number) => y,
        default: () => 0,
    },
    researchResults: {
        reducer: (x: string[], y: string[]) => x.concat(y),
        default: () => [],
    },
};

// --- Model Initialization ---
const model = new ChatBedrockConverse({
    region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || "Null",
    model: "global.anthropic.claude-sonnet-4-5-20250929-v1:0", // Keeping consistent with existing graph
    maxTokens: 4096,
    temperature: 0,
    streaming: true,
});

const tools = [executeCommandTool];
const modelWithTools = model.bindTools(tools);

// --- Nodes ---

// 1. Planner Node
// Decomposes the user's request into a list of actionable steps.
async function plannerNode(state: AgentState) {
    const { messages } = state;
    const lastMessage = messages[messages.length - 1];

    const plannerSystemContext = new SystemMessage(
        `You are an expert Planner Agent. Your job is to break down the user's request into a logical sequence of steps.
        
        Rules:
        1.  Analyze the user's request: "${lastMessage.content}"
        2.  Create a concise, numbered list of steps to achieve the goal.
        3.  Steps should be actionable (e.g., "Check file system", "Analyze code", "Run tests").
        4.  Do not actually execute the steps; just list them.
        5.  Return the plan as a strictly formatted JSON array of strings in your response content.
            Example: ["Run ls -la to check files", "Read specific configuration file", "Synthesize findings"]`
    );

    console.log("--- [Planner Node] Invoked ---");
    console.log(`[Planner] User Request: "${lastMessage.content}"`);

    // We force the model to return JSON by prompting (Bedrock specific JSON mode might be strictly safer but this works well with Claude)
    const response = await model.invoke([plannerSystemContext, lastMessage]);

    let plan: string[] = [];
    try {
        console.log(`[Planner] Raw LLM Response:`, response.content);
        // Attempt to parse JSON from the response text. 
        // We look for a JSON array pattern if there's extra text.
        const content = response.content as string;
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            plan = JSON.parse(jsonMatch[0]);
        } else {
            // Fallback: split by newlines if it looks like a list
            plan = content.split('\n').filter(line => /^\d+\./.test(line)).map(line => line.replace(/^\d+\.\s*/, '').trim());
        }

        if (plan.length === 0) {
            // If parsing completely fails, treat the whole response as one step (or failover)
            plan = ["Analyze and respond to user request"];
        }
    } catch (e) {
        console.error("[Planner] Plan parsing failed", e);
        plan = ["Analyze and respond to user request"];
    }

    console.log(`[Planner] Generated Plan:`, JSON.stringify(plan, null, 2));

    // We communicate the plan back to the user internally via a distinct message type if needed, 
    // but here we store it in state.
    // We also append an AIMessage purely for the history log so the agent "knows" it planned.
    return {
        plan,
        currentStepIndex: 0,
        messages: [new AIMessage({ content: `Proposed Plan:\n${plan.map((s, i) => `${i + 1}. ${s}`).join('\n')}` })]
    };
}

// 2. Executor Node
// Executes the current step in the plan.
async function executorNode(state: AgentState) {
    const { plan, currentStepIndex, messages } = state;
    console.log(`--- [Executor Node] Invoked for Step ${currentStepIndex + 1}/${plan.length} ---`);

    if (currentStepIndex >= plan.length) {
        console.log("[Executor] Plan complete, no more steps.");
        return { messages: [] }; // Done
    }

    const currentStep = plan[currentStepIndex];
    console.log(`[Executor] Executing Step: "${currentStep}"`);

    const executorSystemContext = new SystemMessage(
        `You are an Executor Agent. You are currently executing Step ${currentStepIndex + 1} of the plan:
        "${currentStep}"

        Your Goal: Successfully complete this step using available tools.
        
        Context:
        - Full Plan: ${JSON.stringify(plan)}
        - History: See previous messages.

        Instructions:
        - If you need to run a command, use the 'execute_command' tool.
        - If the step is "Research" or requires knowledge you don't have, try to find it via commands (e.g. searching files) or simply state what you observe.
        - If you have completed the step, provide a summary of what you did.
        `
    );

    // Filter relevant history or pass all? Passing all for full context.
    const messagesToModel = [executorSystemContext, ...messages];

    console.log(`[Executor] Invoking model with ${messagesToModel.length} messages context.`);
    const response = await modelWithTools.invoke(messagesToModel);
    console.log(`[Executor] Model Response:`, JSON.stringify(response, null, 2));

    return { messages: [response] };
}

// 3. Tool Node
const toolNode = new ToolNode(tools);

// 4. Replanner Node
// Evaluates progress and decides whether to continue to the next step, update the plan, or finish.
async function replannerNode(state: AgentState) {
    const { currentStepIndex } = state;
    console.log(`--- [Replanner Node] Invoked. Moving from Step ${currentStepIndex} to ${currentStepIndex + 1} ---`);

    // If the last thing happened was a tool call, we simply loop back to Executor to process the result (ReAct loop within a step)
    // BUT the Executor Node logic above just invoked the model. The model execution output IS 'lastMessage'.
    // If 'lastMessage' has tool_calls, we need to go to ToolNode.
    // Wait, the Logic for routing to tools is usually conditional edges.

    // Let's look at the result of the Executor step.
    // If the executor said "I am done with this step", we proceed.
    // We can prompt the Replanner to decide.

    // Simplification for V1:
    // If the Executor produced a text response (no tool calls), we assume the step is done for now or at least attempted.
    // We verify if we should mark the step as complete.

    return { currentStepIndex: currentStepIndex + 1 };
}

// --- Conditional Logic ---

function shouldContinueFromExecutor(state: AgentState) {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1] as AIMessage;

    // If the executor wants to call a tool, let it.
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
        return "tools";
    }

    // Otherwise, we assume the step is "handled" (possibly with just a text response) 
    // and we move to the Replanner/Next Step logic.
    return "replanner";
}

function shouldContinueFromReplanner(state: AgentState) {
    const { plan, currentStepIndex } = state;

    if (currentStepIndex < plan.length) {
        return "executor";
    }

    return END;
}

// --- Graph Construction ---
const workflow = new StateGraph<AgentState>({ channels: graphState })
    .addNode("planner", plannerNode)
    .addNode("executor", executorNode)
    .addNode("tools", toolNode)
    .addNode("replanner", replannerNode) // Acts as a "Next Step" manager

    .addEdge(START, "planner")
    .addEdge("planner", "executor")

    .addConditionalEdges("executor", shouldContinueFromExecutor, {
        tools: "tools",
        replanner: "replanner"
    })

    .addEdge("tools", "executor") // Return to executor after tool use to interpret results

    .addConditionalEdges("replanner", shouldContinueFromReplanner, {
        executor: "executor",
        [END]: END
    });

// --- Checkpointer for persistence ---
const checkpointer = new MemorySaver();

export const deepResearchGraph = workflow.compile({
    checkpointer,
    interruptBefore: ["tools"],
});

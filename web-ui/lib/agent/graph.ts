import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, StateGraphArgs, START, END } from "@langchain/langgraph";
import { ChatBedrockConverse } from "@langchain/aws";
import { executeCommandTool } from "./tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";

// --- State Definition ---
interface AgentState {
    messages: BaseMessage[];
}

// --- Schema for StateGraph ---
const graphState: StateGraphArgs<AgentState>["channels"] = {
    messages: {
        reducer: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
    },
};

// --- Model Initialization ---
const model = new ChatBedrockConverse({
    region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || "Null",
    // Use the latest US inference profile for Claude 3.5 Sonnet v2
    model: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    maxTokens: 4096,
    temperature: 0,
    streaming: true,
});

const tools = [executeCommandTool];
const modelWithTools = model.bindTools(tools);

// --- Nodes ---

// Agent Node: The main brain that decides to call tools or respond
async function agentNode(state: AgentState) {
    const { messages } = state;

    // Add system message to guide the agent
    const systemMessage = new SystemMessage(
        `You are a DevOps assistant with access to system commands. 
        Analyze user requests carefully and use available tools to gather information.
        After executing commands, provide clear, concise explanations of the results.
        If multiple commands are needed, execute them one at a time.
        ALWAYS run 'ls -la' first to explore the directory if asked about files.`
    );

    const messagesToModel = [systemMessage, ...messages];

    // Simply invoke the model with tools bound
    const response = await modelWithTools.invoke(messagesToModel);
    return { messages: [response] };
}

// Tool Execution Node
const toolNode = new ToolNode(tools);

// --- Conditional Logic ---
function shouldContinue(state: AgentState) {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1] as AIMessage;

    // If the LLM is making a tool call, route to tools node
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
        return "tools";
    }

    // Otherwise, end the conversation
    return END;
}

// --- Graph Construction ---
const workflow = new StateGraph<AgentState>({ channels: graphState })
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent");

// --- Compilation ---
// No checkpointer needed for stateless request handling used by Vercel AI SDK
export const graph = workflow.compile();

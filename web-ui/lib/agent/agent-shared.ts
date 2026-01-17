import { BaseMessage, AIMessage, HumanMessage } from "@langchain/core/messages";
import { StateGraphArgs } from "@langchain/langgraph";
import { FileSaver } from "./file-saver";
import { DynamoDBSaver } from "@rwai/langgraphjs-checkpoint-dynamodb";
import { DynamoDBS3Saver } from "./dynamodb-s3-saver";
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

// --- Components & Interfaces ---

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
export const graphState: StateGraphArgs<ReflectionState>["channels"] = {
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
export const MAX_ITERATIONS = 30;

// --- Helper Functions ---
export function truncateOutput(text: string, maxChars: number = 500): string {
    if (!text) return "";
    if (text.length > maxChars) {
        return text.slice(0, maxChars) + "...";
    }
    return text;
}

// Get recent messages safely - ensuring tool call/result pairs are kept together
// Also filters out empty messages that cause Bedrock API errors
export function getRecentMessages(messages: BaseMessage[], maxMessages: number = 8): BaseMessage[] {
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
    accountId?: string;   // Optional: AWS account ID for context
    accountName?: string; // Optional: AWS account name for display
}

// --- State Definition ---
// Shared checkpointer for the session (backed by file system or DynamoDB)
// Usage of globalThis ensures the checkpointer survives Next.js hot reloads in dev mode
const globalForCheckpointer = globalThis as unknown as { checkpointer: BaseCheckpointSaver };

function getCheckpointer() {
    if (globalForCheckpointer.checkpointer) return globalForCheckpointer.checkpointer;

    if (process.env.DYNAMODB_CHECKPOINT_TABLE && process.env.DYNAMODB_WRITES_TABLE) {
        console.log("Using DynamoDB Checkpointer with tables:", process.env.DYNAMODB_CHECKPOINT_TABLE, process.env.DYNAMODB_WRITES_TABLE);

        // Use S3 offloading if bucket is configured
        if (process.env.CHECKPOINT_S3_BUCKET) {
            console.log("Using S3 offloading for checkpoints:", process.env.CHECKPOINT_S3_BUCKET);
            return new DynamoDBS3Saver({
                clientConfig: {
                    region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null'
                },
                checkpointsTableName: process.env.DYNAMODB_CHECKPOINT_TABLE,
                writesTableName: process.env.DYNAMODB_WRITES_TABLE,
                s3BucketName: process.env.CHECKPOINT_S3_BUCKET,
                s3ClientConfig: {
                    region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'Null'
                }
            });
        }

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

export const checkpointer = getCheckpointer();
if (process.env.NODE_ENV !== "production") globalForCheckpointer.checkpointer = checkpointer;

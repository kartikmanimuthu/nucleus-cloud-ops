import { BaseMessage, AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { StateGraphArgs } from "@langchain/langgraph";
import { FileSaver } from "./file-saver";
import { DynamoDBSaver } from "@rwai/langgraphjs-checkpoint-dynamodb";
import { DynamoDBS3Saver } from "./dynamodb-s3-saver";
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { SafeMongoDBSaver } from "../deep-agent/db/safe-mongo-saver";
import { getMongoClient } from "../db/mongo-client";

// --- Components & Interfaces ---

export interface PlanStep {
    step: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface ToolResultEntry {
    toolName: string;
    output: string;      // truncated to 1000 chars
    isError: boolean;
    iterationIndex: number;
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
    toolResults: ToolResultEntry[]; // Structured tool results for reflection/summary
}

// --- Schema for StateGraph ---
export const graphState: StateGraphArgs<ReflectionState>["channels"] = {
    messages: {
        reducer: (x: BaseMessage[], y: BaseMessage[]) => {
            const combined = x.concat(y);
            // Cap at 100 messages to prevent checkpoint bloat.
            // getRecentMessages() handles the per-call LLM window independently.
            return combined.length > 100 ? combined.slice(-100) : combined;
        },
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
        reducer: (x: string, y: string) => y || x, // Replace with latest — avoids unbounded accumulation
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
        reducer: (x: ToolResultEntry[], y: ToolResultEntry[]) => [...x, ...y].slice(-10), // cap at 10 to prevent unbounded growth
        default: () => [],
    },
};

// --- Constants ---
export const MAX_ITERATIONS = 30;

// ---------------------------------------------------------------------------
// LLM Audit Logger
// ---------------------------------------------------------------------------
// Logs full LLM input/output at every invoke() call for auditing & debugging.
// Controlled by the LLM_AUDIT env var:
//   LLM_AUDIT=1       → deep audit with full message bodies (default when truthy)
//   LLM_AUDIT=compact → print only a 200-char excerpt of each message
//   (not set)         → audit is DISABLED entirely
// ---------------------------------------------------------------------------

type AuditDepth = 'full' | 'compact';

function getAuditDepth(): AuditDepth | null {
    const v = process.env.LLM_AUDIT?.toLowerCase();
    if (!v || v === '0' || v === 'false') return null;
    if (v === 'compact') return 'compact';
    return 'full'; // any other truthy value → full
}

/** Serialize a single message to a human-readable audit string. */
function formatMessageForAudit(msg: BaseMessage, depth: AuditDepth): string {
    const role = msg._getType().toUpperCase().padEnd(7);
    let body: string;

    if (msg._getType() === 'ai') {
        const ai = msg as AIMessage;
        const parts: string[] = [];

        // Thinking / reasoning blocks (Claude extended thinking)
        if (Array.isArray(ai.content)) {
            for (const block of ai.content as any[]) {
                if (block.type === 'thinking' && block.thinking) {
                    const t = depth === 'compact' ? truncateOutput(block.thinking, 200) : block.thinking;
                    parts.push(`[THINKING]\n${t}`);
                } else if (block.type === 'text' && block.text) {
                    const t = depth === 'compact' ? truncateOutput(block.text, 200) : block.text;
                    parts.push(`[TEXT] ${t}`);
                }
            }
        } else if (typeof ai.content === 'string' && ai.content) {
            const t = depth === 'compact' ? truncateOutput(ai.content, 200) : ai.content;
            parts.push(t);
        }

        // Tool calls
        if (ai.tool_calls && ai.tool_calls.length > 0) {
            for (const tc of ai.tool_calls) {
                const args = depth === 'compact'
                    ? truncateOutput(JSON.stringify(tc.args), 200)
                    : JSON.stringify(tc.args, null, 2);
                parts.push(`[TOOL_CALL] id=${tc.id}  name=${tc.name}\n${args}`);
            }
        }

        body = parts.join('\n') || '(empty)';
    } else {
        const raw = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
        body = depth === 'compact' ? truncateOutput(raw, 200) : raw;
    }

    return `  ${role} │ ${body.replace(/\n/g, '\n            │ ')}`;
}

/**
 * Log a full LLM invoke call for audit purposes.
 *
 * @param node     - Name of the graph node making the call (e.g. "PLANNER", "EXECUTOR")
 * @param inputs   - The message array passed to model.invoke()
 * @param response - The AIMessage returned by model.invoke()
 * @param startMs  - Date.now() captured immediately before the invoke call
 */
export function llmAuditLog(
    node: string,
    inputs: BaseMessage[],
    response: AIMessage,
    startMs: number
): void {
    const depth = getAuditDepth();
    if (!depth) return; // audit disabled

    const latencyMs = Date.now() - startMs;
    const usage = (response as any).usage_metadata;
    const tokenLine = usage
        ? `tokens_in=${usage.input_tokens ?? '?'}  tokens_out=${usage.output_tokens ?? '?'}`
        : 'tokens=unknown';

    const border = '═'.repeat(80);
    const lines: string[] = [
        `\n╔${border}╗`,
        `║  🔍 LLM AUDIT  [${node}]  latency=${latencyMs}ms  ${tokenLine}`,
        `╠${border}╣`,
        `║  ── INPUT MESSAGES (${inputs.length}) ──`,
    ];

    for (const [i, msg] of inputs.entries()) {
        lines.push(`║  [${i}] ${formatMessageForAudit(msg, depth)}`);
    }

    lines.push(`╠${border}╣`);
    lines.push(`║  ── LLM RESPONSE ──`);
    lines.push(`║  ${formatMessageForAudit(response, depth)}`);
    lines.push(`╚${border}╝\n`);

    console.log(lines.join('\n'));
}

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
export function getRecentMessages(messages: BaseMessage[], maxMessages: number = 30): BaseMessage[] {
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

    // Trim from the FRONT to enforce maxMessages, always stripping full tool-pair groups to avoid orphans.
    // We must not split an AI-with-tool-calls and its following ToolMessages.
    while (result.length > maxMessages) {
        // Remove the first element
        result.shift();
        // If the new front is a ToolMessage, keep removing until we reach a non-tool message
        // (we stripped the AI message that owned these tool results, so they'd be orphaned)
        while (result.length > 0 && result[0]._getType() === 'tool') {
            result.shift();
        }
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

/**
 * Ensures every AI message with tool_calls has matching ToolMessages immediately
 * after it in the array. If a tool_call has no result (orphaned), a synthetic
 * ToolMessage is inserted. This prevents Bedrock ValidationException:
 * "tool_use ids were found without tool_result blocks".
 *
 * Call this function immediately before invoking modelWithTools.
 */
export function sanitizeMessagesForBedrock(messages: BaseMessage[]): BaseMessage[] {
    const result: BaseMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        result.push(msg);

        // Only care about AI messages that have tool_calls
        if (msg._getType() !== 'ai') continue;
        const aiMsg = msg as AIMessage;
        if (!aiMsg.tool_calls || aiMsg.tool_calls.length === 0) continue;

        // Collect the tool_call IDs that need to be matched
        const pendingIds = new Set(aiMsg.tool_calls.map(tc => tc.id).filter(Boolean));
        if (pendingIds.size === 0) continue;

        // Scan ahead to consume matching ToolMessages
        const coveredIds = new Set<string>();
        let j = i + 1;
        while (j < messages.length && messages[j]._getType() === 'tool') {
            const toolMsg = messages[j] as any;
            const toolCallId: string | undefined = toolMsg.tool_call_id;
            if (toolCallId && pendingIds.has(toolCallId)) {
                coveredIds.add(toolCallId);
            }
            result.push(messages[j]);
            j++;
        }
        // Advance outer index past the consumed tool messages
        i = j - 1;

        // For any tool_call IDs that had no matching ToolMessage, insert a synthetic one
        for (const toolCall of aiMsg.tool_calls) {
            if (!toolCall.id || coveredIds.has(toolCall.id)) continue;
            result.push(new ToolMessage({
                content: '[Tool result unavailable — synthetic placeholder]',
                tool_call_id: toolCall.id,
                name: toolCall.name,
            }));
        }
    }

    return result;
}

// Configuration for graph creation
export interface AccountContext {
    accountId: string;
    accountName: string;
}

export interface GraphConfig {
    model: string;
    autoApprove: boolean;
    accounts?: AccountContext[];   // Array of AWS accounts for multi-account querying
    accountId?: string;   // Deprecated: Single account (kept for backwards compatibility)
    accountName?: string; // Deprecated: Single account name
    selectedSkill?: string | null; // Selected skill ID for dynamic loading
    mcpServerIds?: string[];       // MCP server IDs to activate for this session
    tenantId?: string;             // Tenant ID to use for fetching configurations
}

// --- MCP Integration ---
// Re-export MCP utilities for use by agent modules
export { getMCPManager } from './mcp-manager';
export { createMCPTools, getMCPToolsDescription } from './mcp-tools';

/**
 * Connect requested MCP servers and return LangChain-compatible tools.
 * Resolves server configs from DynamoDB (user customizations) falling back to defaults.
 * If no server IDs are provided, returns an empty array (backward compatible).
 */
export async function getActiveMCPTools(serverIds?: string[], tenantId?: string) {
    if (!serverIds || serverIds.length === 0) {
        return [];
    }

    const { getMCPManager: getManager } = await import('./mcp-manager');
    const { createMCPTools: createTools } = await import('./mcp-tools');
    const { mergeConfigs } = await import('./mcp-config');
    const manager = getManager();

    // Resolve server configs from DynamoDB + defaults
    let allConfigs;
    try {
        const { TenantConfigService } = await import('../tenant-config-service');
        const savedJson = await TenantConfigService.getConfig('mcp-servers', tenantId);
        allConfigs = mergeConfigs(savedJson);
    } catch (err) {
        console.warn('[getActiveMCPTools] DynamoDB config read failed, using defaults:', err);
        const { DEFAULT_MCP_SERVERS } = await import('./mcp-config');
        allConfigs = DEFAULT_MCP_SERVERS;
    }

    // Connect requested servers (idempotent — skips already-connected)
    await manager.connectServers(serverIds, allConfigs);

    // Convert MCP tools to LangChain format
    return createTools(manager, serverIds);
}

// --- State Definition ---
// Shared checkpointer for the session (backed by MongoDB, DynamoDB, or file system)
// Usage of globalThis ensures the checkpointer survives Next.js hot reloads in dev mode
const globalForCheckpointer = globalThis as unknown as {
    checkpointer: BaseCheckpointSaver | undefined;
    checkpointerPromise: Promise<BaseCheckpointSaver> | undefined;
};

async function initCheckpointer(): Promise<BaseCheckpointSaver> {
    // Priority 1: MongoDB (preferred)
    if (process.env.MONGODB_URI) {
        try {
            const mongoClient = await getMongoClient();
            const saver = new SafeMongoDBSaver({
                client: mongoClient as any,
                dbName: process.env.MONGODB_DB_NAME || process.env.DEEP_AGENT_DB_NAME || 'nucleus',
                checkpointCollectionName: 'agent_checkpoints',
                checkpointWritesCollectionName: 'agent_checkpoint_writes',
            });
            console.log("Using MongoDB Checkpointer (agent_checkpoints)");
            return saver;
        } catch (err) {
            console.warn("MongoDB checkpointer init failed, trying DynamoDB fallback:", err);
        }
    }

    // Priority 2: DynamoDB (existing behavior)
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

    // Priority 3: File system fallback
    console.log("Using FileSystem Checkpointer");
    return new FileSaver();
}

export async function getCheckpointer(): Promise<BaseCheckpointSaver> {
    if (globalForCheckpointer.checkpointer) return globalForCheckpointer.checkpointer;
    if (!globalForCheckpointer.checkpointerPromise) {
        globalForCheckpointer.checkpointerPromise = initCheckpointer().then(cp => {
            globalForCheckpointer.checkpointer = cp;
            return cp;
        });
    }
    return globalForCheckpointer.checkpointerPromise;
}

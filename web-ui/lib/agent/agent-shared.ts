import { BaseMessage, AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { StateGraphArgs } from "@langchain/langgraph";
import { getCheckpointer as getPersistenceCheckpointer, getMemoryStore as getPersistenceMemoryStore } from "./persistence";

/** Resolved model configuration — provider-agnostic. */
export interface ResolvedModelConfig {
    provider: "bedrock" | "openai-compatible";
    modelId: string;
    baseUrl?: string;
    apiKey?: string;
    maxTokens?: number;
}

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
    // Pass 1: collect every tool_call_id that already has a ToolMessage response
    // anywhere in the array (not just consecutively after the AI message).
    const answeredToolCallIds = new Set<string>();
    for (const msg of messages) {
        if (msg._getType() === 'tool') {
            const toolCallId: string | undefined = (msg as any).tool_call_id;
            if (toolCallId) answeredToolCallIds.add(toolCallId);
        }
    }

    // Pass 2: rebuild the array, inserting synthetic ToolMessages for any
    // AI tool_call IDs that have no matching ToolMessage in the conversation.
    const result: BaseMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        result.push(msg);

        if (msg._getType() !== 'ai') continue;
        const aiMsg = msg as AIMessage;

        // Collect tool_call IDs from both normalized tool_calls AND raw Bedrock
        // content blocks (type=tool_use). After checkpoint round-trips the two
        // can diverge.
        const pendingIds = new Map<string, string>(); // id → name
        if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
            for (const tc of aiMsg.tool_calls) {
                if (tc.id) pendingIds.set(tc.id, tc.name ?? 'unknown');
            }
        }
        if (Array.isArray(aiMsg.content)) {
            for (const block of aiMsg.content as any[]) {
                if (block?.type === 'tool_use' && block?.id) {
                    if (!pendingIds.has(block.id)) pendingIds.set(block.id, block.name ?? 'unknown');
                }
            }
        }
        if (pendingIds.size === 0) continue;

        // Consume consecutive ToolMessages (the normal case)
        let j = i + 1;
        while (j < messages.length && messages[j]._getType() === 'tool') {
            result.push(messages[j]);
            j++;
        }
        i = j - 1;

        // Insert synthetic placeholders for any tool_call IDs that have no
        // matching ToolMessage anywhere in the conversation.
        for (const [id, name] of pendingIds) {
            if (answeredToolCallIds.has(id)) continue;
            result.push(new ToolMessage({
                content: '[Tool result unavailable — synthetic placeholder]',
                tool_call_id: id,
                name,
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
    model: ResolvedModelConfig;
    autoApprove: boolean;
    accounts?: AccountContext[];
    accountId?: string;
    accountName?: string;
    selectedSkill?: string | null;
    mcpServerIds?: string[];
    tenantId?: string;
    userId?: string;  // For long-term memory store scoping
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
export async function getActiveMCPTools(serverIds?: string[], tenantId?: string, accounts?: AccountContext[]) {
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

    const requestedConfigs = allConfigs.filter(c => serverIds.includes(c.id));
    const credentialServerConfigs = requestedConfigs.filter(c => c.requiresAwsCredentials);
    const regularServerIds = requestedConfigs.filter(c => !c.requiresAwsCredentials).map(c => c.id);

    const effectiveAccounts = accounts && accounts.length > 0 ? accounts : [];

    console.log(`[getActiveMCPTools] accounts=${effectiveAccounts.map(a => a.accountId).join(',') || '(none)'} | Resolved ${requestedConfigs.length} server configs`);
    console.log(`[getActiveMCPTools] Credential servers (${credentialServerConfigs.length}): ${credentialServerConfigs.map(c => c.id).join(', ') || 'none'}`);
    console.log(`[getActiveMCPTools] Regular servers (${regularServerIds.length}): ${regularServerIds.join(', ') || 'none'}`);

    // Connect regular servers (idempotent — skips already-connected)
    if (regularServerIds.length > 0) {
        await manager.connectServers(regularServerIds, allConfigs);
    }

    // Connect credential-sensitive servers for ALL selected accounts
    const scopedInstanceIds: string[] = [];
    if (credentialServerConfigs.length > 0 && effectiveAccounts.length > 0) {
        const { assumeRoleForAccount } = await import('./aws-credentials-tool');
        const { AccountService } = await import('../account-service');

        for (const accountCtx of effectiveAccounts) {
            try {
                const account = await AccountService.getAccount(accountCtx.accountId, tenantId!);
                if (!account || !account.roleArn) {
                    console.warn(`[getActiveMCPTools] Account ${accountCtx.accountId} not found or missing roleArn — skipping`);
                    continue;
                }
                const region = account.regions?.[0] || process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1';
                const { credentials } = await assumeRoleForAccount(account.roleArn, account.externalId);
                const awsCredentials = {
                    accessKeyId: credentials.AccessKeyId!,
                    secretAccessKey: credentials.SecretAccessKey!,
                    sessionToken: credentials.SessionToken!,
                    region,
                };
                for (const config of credentialServerConfigs) {
                    try {
                        const scopedId = await manager.connectServerWithAwsCredentials(config, accountCtx.accountId, awsCredentials);
                        scopedInstanceIds.push(scopedId);
                    } catch (err: any) {
                        console.error(`[getActiveMCPTools] Failed to connect "${config.id}" for account ${accountCtx.accountId}:`, err.message);
                    }
                }
            } catch (err: any) {
                console.error(`[getActiveMCPTools] Failed to obtain credentials for account ${accountCtx.accountId}:`, err.message);
            }
        }
    }

    const allInstanceIds = [...regularServerIds, ...scopedInstanceIds];
    return createTools(manager, allInstanceIds);
}

// --- State Definition ---
// Delegate to persistence.ts which is the single source of truth for all LangGraph persistence.

export async function getCheckpointer() {
    return getPersistenceCheckpointer();
}

export async function getStore() {
    return getPersistenceMemoryStore();
}

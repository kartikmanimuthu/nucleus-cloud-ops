import { BaseMessage, AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { StateGraphArgs } from "@langchain/langgraph";
import { getCheckpointer as getPersistenceCheckpointer, getMemoryStore as getPersistenceMemoryStore } from "./persistence";
import { env } from "@/env";
import type { Scratchpad, MemoryStats } from "./memory/types";

/** Resolved model configuration — provider-agnostic. */
export interface ResolvedModelConfig {
    provider:
        | "bedrock"
        | "openai"
        | "openai-compatible"
        | "anthropic"
        | "ollama"
        | "vllm"
        | "litellm"
        | "lmstudio";
    modelId: string;
    baseUrl?: string;
    apiKey?: string;
    maxTokens?: number;
    /** Sampling temperature. OMITTED by default — newer models (e.g. Bedrock Claude
     *  Sonnet 5) reject any `temperature` parameter with a ValidationException, so we
     *  only send one when a provider's model entry explicitly configures it. */
    temperature?: number;
    /** Bedrock-only: region + explicit static credentials (when configured as a provider record). */
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
}

/**
 * Provider types whose wire protocol is OpenAI-compatible (`/v1/chat/completions`),
 * so they all share the ChatOpenAI transport in model-factory. OpenAI, Ollama,
 * LiteLLM, LM Studio, vLLM, LocalAI, etc. expose this same surface.
 */
export const OPENAI_COMPATIBLE_PROVIDERS = [
    "openai",
    "openai-compatible",
    "ollama",
    "vllm",
    "litellm",
    "lmstudio",
] as const;

export type OpenAICompatibleProvider = (typeof OPENAI_COMPATIBLE_PROVIDERS)[number];

export function isOpenAICompatibleProvider(
    provider: ResolvedModelConfig["provider"],
): provider is OpenAICompatibleProvider {
    return (OPENAI_COMPATIBLE_PROVIDERS as readonly string[]).includes(provider);
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
    memoryContext: string; // Formatted relevant memories from recall node
    memoryStats: MemoryStats | null;
    runningSummary: string; // Phase 1: rolling summary of compacted turns
    scratchpad: Scratchpad; // Phase 1: structured working-memory scratchpad
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
    memoryContext: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
    memoryStats: {
        reducer: (x: MemoryStats | null, y: MemoryStats | null) => y ?? x,
        default: () => null,
    },
    runningSummary: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
    scratchpad: {
        reducer: (x: Scratchpad, y: Scratchpad) => y || x,
        default: () => ({ openGoals: [], keyFindings: [], resourceIds: [], pendingSteps: [] }),
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
    const v = env.LLM_AUDIT?.toLowerCase();
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

/**
 * Tags an AI message with the agent phase ("execution", "reflection", "final", …) that
 * produced it, stored under `response_metadata.agentPhase`.
 *
 * Why: the chat route renders phase headers/cards from the LangGraph node a message came
 * from. During LIVE streaming that node is read from each chunk's metadata, but when a
 * conversation is reloaded from history the node is unknown — previously it was guessed
 * positionally, which drifted out of alignment (extra reflector/memory model calls produce
 * no persisted message) and mislabeled phases (e.g. a reflection rendered as EXECUTION).
 * Tagging the phase at creation makes history reconstruction exact and identical to live.
 *
 * `response_metadata` is round-tripped by the checkpointer and is NOT sent back to the model
 * as input, so it is a safe place for this UI hint.
 */
export function tagMessagePhase<T extends BaseMessage>(msg: T, phase: string): T {
    (msg as any).response_metadata = { ...((msg as any).response_metadata ?? {}), agentPhase: phase };
    return msg;
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
/**
 * Detects an extended-thinking / reasoning content block in either the LangChain
 * normalized shape (`type: 'thinking' | 'reasoning' | 'reasoning_content' | …`) or
 * the raw Bedrock Converse shape (`{ reasoningContent: { reasoningText: … } }`).
 */
function isReasoningBlock(b: unknown): boolean {
    if (!b || typeof b !== 'object') return false;
    const block = b as Record<string, unknown>;
    if ('reasoningContent' in block || 'reasoning_content' in block) return true;
    const t = block.type;
    return t === 'reasoning_content' || t === 'reasoning' || t === 'thinking'
        || t === 'redacted_reasoning' || t === 'redacted_thinking';
}

/**
 * Removes reasoning/thinking content blocks from an AI message's content array.
 *
 * Why: Bedrock Claude Sonnet 5 emits `reasoningContent` blocks, but these do not
 * survive the checkpoint round-trip intact — on replay `reasoningText.text` comes
 * back null, and Bedrock rejects the next invoke with
 *   ValidationException: Value at 'messages.N.content.M.reasoningContent.reasoningText.text'
 *   failed to satisfy constraint: Member must not be null
 * Reasoning content is the model's own scratchpad, not required for context
 * fidelity, and we do not explicitly enable extended thinking (so Bedrock does not
 * require it on replay). Stripping it is the safe, standard mitigation. Returns the
 * original message untouched when it carries no reasoning blocks.
 */
function stripReasoningBlocks(msg: BaseMessage): BaseMessage {
    if (msg._getType() !== 'ai') return msg;
    const ai = msg as AIMessage;
    if (!Array.isArray(ai.content)) return msg;
    const original = ai.content as unknown[];
    const filtered = original.filter((b) => !isReasoningBlock(b));
    if (filtered.length === original.length) return msg; // nothing to strip
    return new AIMessage({
        content: filtered as AIMessage['content'],
        tool_calls: ai.tool_calls,
        additional_kwargs: ai.additional_kwargs,
        response_metadata: ai.response_metadata,
        id: ai.id,
        name: ai.name,
        usage_metadata: ai.usage_metadata,
    });
}

export function sanitizeMessagesForBedrock(messages: BaseMessage[]): BaseMessage[] {
    // Bedrock requires every toolResult to IMMEDIATELY follow the assistant
    // toolUse that owns it — "answered somewhere in the array" is not enough.
    // Upstream windowing (getRecentMessages) can inject a synthetic
    // HumanMessage("Proceed.") between an AI tool_use and its ToolMessage, which
    // breaks that adjacency and triggers:
    //   ValidationException: Expected toolResult blocks at messages.N.content
    //
    // To guarantee adjacency regardless of how the array was reordered, we index
    // every ToolMessage by its tool_call_id, then re-emit each result directly
    // after its owning AI message. Results are NOT emitted in place; orphan
    // results whose tool_use is absent are dropped (Bedrock also rejects a
    // toolResult that has no preceding toolUse).

    // Pass 1: map each tool_call_id → its ToolMessage (first occurrence wins).
    const toolResultById = new Map<string, BaseMessage>();
    for (const msg of messages) {
        if (msg._getType() === 'tool') {
            const toolCallId: string | undefined = (msg as any).tool_call_id;
            if (toolCallId && !toolResultById.has(toolCallId)) {
                toolResultById.set(toolCallId, msg);
            }
        }
    }

    // Pass 2: rebuild the array. ToolMessages are skipped where they sit and
    // re-attached next to their owning AI message; missing results get a
    // synthetic placeholder so no tool_use is ever left unanswered.
    const result: BaseMessage[] = [];

    for (const msg of messages) {
        // Skip ToolMessages here — they are re-emitted via their AI owner below.
        if (msg._getType() === 'tool') continue;

        // Strip reasoning/thinking blocks from AI messages — they come back with a
        // null reasoningText after a checkpoint round-trip and Bedrock rejects them.
        const cleaned = stripReasoningBlocks(msg);
        result.push(cleaned);

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

        // Emit one toolResult per tool_use id, immediately after the AI message
        // and in tool_use order. Use the real ToolMessage if we have one
        // (wherever it sat in the original array); otherwise a synthetic
        // placeholder.
        for (const [id, name] of pendingIds) {
            const realResult = toolResultById.get(id);
            if (realResult) {
                result.push(realResult);
            } else {
                result.push(new ToolMessage({
                    content: '[Tool result unavailable — synthetic placeholder]',
                    tool_call_id: id,
                    name,
                }));
            }
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
    knowledgeBaseIds?: string[] | null;
    maxIterations?: number;  // Agent Ops per-tenant graph iteration limit (executor loop + recursionLimit)
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

    const { getMCPManager: getManager, tenantScopedKey } = await import('./mcp-manager');
    const { createMCPTools: createTools } = await import('./mcp-tools');
    const { mergeConfigs, resolveEnabledServerIds } = await import('./mcp-config');
    const manager = getManager();

    // MCP connections are cached per tenant so no tenant reuses another's live
    // subprocess/token. Fall back to 'default' only when no tenant is supplied.
    const tid = tenantId || 'default';

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

    const enabledIds = resolveEnabledServerIds(serverIds, allConfigs);
    const requestedConfigs = allConfigs.filter(c => enabledIds.includes(c.id));
    const credentialServerConfigs = requestedConfigs.filter(c => c.requiresAwsCredentials);
    const regularServerIds = requestedConfigs.filter(c => !c.requiresAwsCredentials).map(c => c.id);

    const effectiveAccounts = accounts && accounts.length > 0 ? accounts : [];

    console.log(`[getActiveMCPTools] accounts=${effectiveAccounts.map(a => a.accountId).join(',') || '(none)'} | Resolved ${requestedConfigs.length} server configs`);
    console.log(`[getActiveMCPTools] Credential servers (${credentialServerConfigs.length}): ${credentialServerConfigs.map(c => c.id).join(', ') || 'none'}`);
    console.log(`[getActiveMCPTools] Regular servers (${regularServerIds.length}): ${regularServerIds.join(', ') || 'none'}`);

    // Connect regular servers (idempotent — skips already-connected)
    if (regularServerIds.length > 0) {
        await manager.connectServers(regularServerIds, allConfigs, tid);
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
                const region = account.regions?.[0] || env.AWS_REGION || env.NEXT_PUBLIC_AWS_REGION || 'us-east-1';
                const { credentials } = await assumeRoleForAccount(account.roleArn, account.externalId);
                const awsCredentials = {
                    accessKeyId: credentials.AccessKeyId!,
                    secretAccessKey: credentials.SecretAccessKey!,
                    sessionToken: credentials.SessionToken!,
                    region,
                };
                for (const config of credentialServerConfigs) {
                    try {
                        const scopedId = await manager.connectServerWithAwsCredentials(config, accountCtx.accountId, awsCredentials, tid);
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

    // Regular tools are cached under the tenant-scoped key; map raw ids accordingly.
    // (scopedInstanceIds are already fully-qualified keys returned by the manager.)
    const regularInstanceIds = regularServerIds.map(id => tenantScopedKey(tid, id));
    const allInstanceIds = [...regularInstanceIds, ...scopedInstanceIds];
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

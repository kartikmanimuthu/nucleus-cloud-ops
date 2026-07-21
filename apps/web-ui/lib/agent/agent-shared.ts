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

/** Verdict produced by the guard node for one pending tool call. */
export interface GuardVerdict {
    toolCallId: string;
    toolName: string;
    isMutative: boolean;
    severity: 'LOW' | 'MEDIUM' | 'HIGH';
    /** One-sentence statement of what the call does (e.g. "Terminates EC2 instance i-0abc"). */
    action: string;
    /** What is affected if this runs (data loss, downstream services, cost). */
    blastRadius: string;
    reversible: boolean;
    /** A less-destructive alternative, or "" when none applies. */
    saferPath: string;
    /** Classifier/LLM reason string for observability. */
    reason: string;
}

export interface ToolResultEntry {
    toolName: string;
    output: string;      // truncated to 1000 chars
    isError: boolean;
    iterationIndex: number;
    /** The tool call's args, when available — lets the reflector distinguish
     *  otherwise-identical tool names (e.g. which region/resource a call targeted). */
    args?: unknown;
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
    guardVerdicts: Record<string, GuardVerdict>; // keyed by toolCallId, replaced per guard pass
    /** Consecutive no-tool-call revisions (planning-agent only). Optional so fast-agent,
     *  which shares this state type but has no reviser/stall logic, is unaffected. */
    stallCount?: number;
    reflectionStallCount?: number; // consecutive unparseable/empty reflections (parse-failure fail-safe)
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
    guardVerdicts: {
        reducer: (x: Record<string, GuardVerdict>, y: Record<string, GuardVerdict>) => y,
        default: () => ({}),
    },
    stallCount: {
        reducer: (x: number | undefined, y: number | undefined) => y ?? x,
        default: () => 0,
    },
    reflectionStallCount: {
        reducer: (x: number | undefined, y: number | undefined) => y ?? x ?? 0,
        default: () => 0,
    },
};

/**
 * Extract the plain text of an LLM response, whatever shape it arrives in.
 *
 * Bedrock returns `AIMessage.content` as EITHER a string OR an array of content
 * blocks ([{type:'text',text:'…'}, {type:'tool_use',…}]) — and under streaming
 * the text blocks are un-coalesced per-delta. Casting that array `as string`
 * (which several nodes used to do) is a lie TypeScript cannot catch: at runtime
 * `content.match(...)` / `content.toLowerCase()` throw TypeError, and
 * `String(content)` yields "[object Object],[object Object]".
 *
 * That crash silently broke plan parsing and, worse, made the reflector return
 * isComplete=false forever — spinning the reflect→revise loop until
 * MAX_ITERATIONS. ALWAYS route LLM content through this helper.
 *
 * Text deltas carry their own leading spaces, so blocks join with '' (never '\n',
 * which shatters the prose one delta per line).
 */
export function extractTextContent(content: unknown): string {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((block: any) => {
                if (typeof block === 'string') return block;
                if (block?.type === 'text' && typeof block.text === 'string') return block.text;
                return '';
            })
            .join('');
    }
    return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

/**
 * Decide what to do with a reflector critique.
 *
 * 'accept' when the critique says COMPLETE — or when it is EMPTY. An empty
 * critique happens for real: Claude Sonnet 5 on Bedrock emits a
 * reasoning_content block first, and if the reflector's output budget runs out
 * mid-reasoning (stopReason max_tokens) there is no text at all. Feeding an
 * empty "[REFLECTION FEEDBACK]" back to the agent just burns iterations — the
 * agent has nothing to fix, so accept the answer instead.
 */
export function critiqueVerdict(critique: string): 'accept' | 'revise' {
    const trimmed = critique.trim();
    if (!trimmed) return 'accept';
    if (trimmed.includes('COMPLETE')) return 'accept';
    return 'revise';
}

/**
 * Format the run's tool results as ground-truth evidence for the reflector.
 *
 * Takes ALL results (already capped at 10 by the toolResults reducer), not just
 * the current iteration's: reflection usually runs an iteration or two AFTER
 * the tool calls (on the no-tools text turn), and a per-iteration filter hands
 * the reflector an empty log — which it reads as "no tools were run" and then
 * falsely accuses the agent of fabricating data it genuinely fetched.
 */
export function buildToolExecutionLog(
    toolResults: ToolResultEntry[] | undefined,
): string {
    if (!toolResults?.length) return '';
    const entries = toolResults
        .map(tr => `- [iteration ${tr.iterationIndex}] ${tr.toolName}: ${tr.isError ? 'ERROR' : 'OK'}\n  Output: ${tr.output}`)
        .join('\n');
    return `\n<TOOL_EXECUTION_LOG>\nThe following tools were executed during this run:\n${entries}\n</TOOL_EXECUTION_LOG>\n`;
}

// --- Constants ---
export const MAX_ITERATIONS = 30;

// Reflect→revise stall detection. If the reflector reports the SAME blocking
// issue in this many consecutive reflections, the revise step isn't making
// progress — finalize with current findings instead of churning to
// MAX_ITERATIONS (which wastes tokens and leaves the run looking "hung").
export const REFLECTION_STALL_LIMIT = 2;

/**
 * Decide whether the reflect→revise loop has stalled. A stall is the SAME
 * non-empty blocking issue repeating across consecutive reflections: the
 * revise attempts aren't resolving it. Any change in the issue (or an issue
 * clearing to 'None'/'') resets the counter.
 *
 * Heuristic by design — it matches on the reflector's verbatim issues string,
 * so a model that rephrases the same blocker each round won't trip it; the
 * MAX_ITERATIONS cap remains the hard backstop for those cases.
 */
export function computeReflectionStall(
    currentIssues: string,
    prevIssues: string | undefined,
    prevStallCount: number,
): { stallCount: number; stalled: boolean } {
    const hasIssue = !!currentIssues && currentIssues !== 'None';
    const repeated = hasIssue && !!prevIssues && prevIssues === currentIssues;
    const stallCount = repeated ? prevStallCount + 1 : 0;
    return { stallCount, stalled: stallCount >= REFLECTION_STALL_LIMIT };
}

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
        // Audit output is meant to be human-readable text. contentToText flattens
        // Sonnet 5-style block arrays; fall back to JSON.stringify only when the
        // content is a non-string shape with no extractable text (keeps fidelity
        // for exotic block types rather than logging an empty line).
        const text = contentToText(msg.content);
        const raw = typeof msg.content === 'string'
            ? msg.content
            : (text || JSON.stringify(msg.content));
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

/**
 * Normalize AIMessage.content to plain text. Newer models (e.g. Claude Sonnet 5
 * via Bedrock) return an ARRAY of content blocks instead of a string; code that
 * parses model output (plan JSON, reflector JSON, guard risk JSON) must extract
 * the text blocks rather than String()/JSON.stringify()-ing the array.
 */
export function contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((block) => {
                if (typeof block === 'string') return block;
                if (block && typeof block === 'object') {
                    const b = block as Record<string, unknown>;
                    if (typeof b.text === 'string') return b.text;
                }
                return '';
            })
            .join('');
    }
    if (content == null) return '';
    return JSON.stringify(content);
}

export function truncateOutput(text: string, maxChars: number = 500): string {
    if (!text) return "";
    if (text.length > maxChars) {
        return text.slice(0, maxChars) + "...";
    }
    return text;
}

/**
 * Truncation variant for text shown to a REVIEWER model (e.g. the reflector's
 * "Recent Assistant Output" slot). truncateOutput()'s bare "..." made the
 * reflector read its own input truncation as a truncated DELIVERABLE ("the
 * final report was cut off mid-sentence") and force a redundant re-render
 * cycle. This marker states explicitly that only the review copy is cut.
 */
export function truncateForReview(text: string, maxChars: number): string {
    if (!text) return "";
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars)
        + `\n…[TRUNCATED FOR REVIEW ONLY — the actual message is ${text.length} characters and continues past this cutoff; do NOT treat this cutoff as an incomplete or truncated deliverable]`;
}

/**
 * Precise tool-result error classifier shared by the fast and planning agents.
 *
 * Replaces the old substring heuristic (`content includes "error"/"exception"`),
 * which false-flagged successful outputs that merely MENTION errors — e.g. a
 * CloudWatch query for the "Errors" metric returning {"Label": "Errors", ...}.
 *
 * Failure contracts (see tools.ts / mcp-tools.ts / aws-credentials-tool.ts):
 *  - LangChain sets ToolMessage.status === 'error' when a tool throws.
 *  - execute_command failures return output starting with "Command failed:".
 *  - File/S3/jail/MCP/ToolNode errors return strings starting with "Error:" or
 *    "Error <doing X>:" — i.e. an "Error"-prefixed string.
 *  - glob/grep/web_search return "Glob error:" / "Grep error:" / "Web search error:".
 *  - JSON tools (get_aws_credentials, list_aws_accounts) return {"success": false, ...}.
 * All checks are trimmed-prefix (case-sensitive) or parsed-JSON — never
 * substring-anywhere.
 */
export function isToolResultError(status: string | undefined, rawContent: string): boolean {
    if (status === 'error') return true;
    if (!rawContent) return false;
    const text = rawContent.trimStart();
    if (text.startsWith('Command failed:')) return true;
    if (text.startsWith('Error:') || text.startsWith('Error ')) return true;
    if (text.startsWith('Glob error:') || text.startsWith('Grep error:') || text.startsWith('Web search error:')) return true;
    if (text.startsWith('{')) {
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && (parsed as { success?: unknown }).success === false) {
                return true;
            }
        } catch {
            // Not valid JSON (e.g. truncated tool output) — fall through to non-error.
        }
    }
    return false;
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

/**
 * Build a state VIEW for ToolNode whose last AIMessage carries only the tool
 * calls that do not yet have a ToolMessage result (per-tool reject / ask_user
 * answers write results BEFORE the tools node runs). ToolNode executes every
 * tool_call on the last AI message — without this filter, a rejected call
 * would execute anyway. Returns null when nothing is left to execute.
 * The underlying graph state is never mutated.
 */
export function withUnresolvedToolCallsOnly(
    state: { messages: BaseMessage[] },
): { messages: BaseMessage[] } | null {
    const messages = state.messages ?? [];
    let lastAiIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]._getType() === 'ai') { lastAiIdx = i; break; }
    }
    if (lastAiIdx === -1) return null;
    const ai = messages[lastAiIdx] as AIMessage;
    const calls = ai.tool_calls ?? [];
    if (calls.length === 0) return null;

    const resolved = new Set<string>();
    for (let i = lastAiIdx + 1; i < messages.length; i++) {
        const m = messages[i] as unknown as { tool_call_id?: string };
        if (messages[i]._getType() === 'tool' && m.tool_call_id) resolved.add(m.tool_call_id);
    }
    const unresolved = calls.filter(c => c.id && !resolved.has(c.id));
    if (unresolved.length === 0) return null;
    if (unresolved.length === calls.length) return { messages };

    const filteredAi = new AIMessage({
        content: ai.content,
        tool_calls: unresolved,
        additional_kwargs: ai.additional_kwargs,
        response_metadata: ai.response_metadata,
        id: ai.id,
    });
    // Execution-scoped clone for ToolNode only — not a general-purpose message copy (drops usage_metadata/name).
    const view = [...messages];
    view[lastAiIdx] = filteredAi;
    return { messages: view };
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
    // Per-session "Auto skills" console toggle (default on). false hides the
    // skill catalog from prompts and drops the load_skill tool — the agent can
    // then only use a skill the user pinned manually.
    autoLoadSkills?: boolean;
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

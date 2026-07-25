/**
 * Sub-agent runtime — the Claude Code `Task` pattern.
 *
 * An ephemeral ReAct loop with its OWN message list. The orchestrator sees only
 * the returned report, never the raw tool output, which is what keeps the
 * orchestrator's context (and therefore its per-lap latency) flat.
 *
 * Sub-agents are strictly READ-ONLY. LangGraph cannot interrupt inside a tool
 * call, so a mutation attempted here could never reach the guard node's human
 * approval gate. Mutations stay on the orchestrator's guarded path.
 *
 * Not checkpointed: a sub-agent is not resumable, so a checkpointer would cost a
 * Postgres write per lap for no benefit.
 */
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { classifyTool } from './tool-classifier';
import { contentToText, truncateOutput } from './agent-shared';
import type { SubagentBudgetConfig } from './subagent-budget';

/** ~1500 tokens. Enforced in characters so the bound is deterministic and testable. */
export const SUBAGENT_REPORT_MAX_CHARS = 6000;

/** Per-tool output cap inside a sub-agent — it never leaves this context. */
const SUBAGENT_TOOL_OUTPUT_MAX_CHARS = 4000;

/**
 * Never available to a sub-agent regardless of what the classifier says.
 * - dispatch_agent: depth cap of 1. Recursion makes cost and latency unbounded.
 * - ask_user: pauses for a human, and no human is reachable inside a tool call.
 */
const SUBAGENT_TOOL_DENYLIST = new Set(['dispatch_agent', 'ask_user']);

export interface SubagentSpec {
    role: string;
    task: string;
    expectedOutput: string;
}

export interface SubagentTranscriptEntry {
    kind: 'ai' | 'tool';
    name?: string;
    text: string;
}

export interface SubagentResult {
    report: string;
    toolCount: number;
    tokensIn: number;
    tokensOut: number;
    status: 'done' | 'failed';
    transcript: SubagentTranscriptEntry[];
}

interface SubagentToolLike {
    name: string;
    invoke: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface SubagentDeps {
    model: { bindTools?: (tools: unknown[]) => unknown; invoke: (messages: unknown[]) => Promise<unknown> };
    tools: SubagentToolLike[];
    budget: SubagentBudgetConfig;
    onEvent?: (progress: { toolCount: number; tokensIn: number; tokensOut: number }) => void;
}

/**
 * The jail. Fail-closed by design: `classifyTool` returns
 * `{ isMutative: false, matchedRule: false }` for a tool whose name matched no
 * rule at all. In the orchestrator that ambiguity routes to a human; inside a
 * sub-agent there is no human, so an unverified tool is refused.
 */
export function isReadOnlyForSubagent(
    name: string,
    args?: Record<string, unknown>,
): { allowed: boolean; reason: string } {
    // Lowercased: classifyTool() lowercases internally, so once Task 8 adds
    // dispatch_agent to its READ_ONLY_ALLOWLIST a case variant like
    // "Dispatch_Agent" would miss a case-SENSITIVE denylist and then be waved
    // through as allowlisted-read-only. The tool-name lookup below would still
    // catch it, but a safety boundary must not depend on its own backstop.
    if (SUBAGENT_TOOL_DENYLIST.has(name.toLowerCase())) {
        return { allowed: false, reason: `${name} is not available to sub-agents` };
    }

    let classification;
    try {
        classification = classifyTool(name, args);
    } catch (error) {
        return { allowed: false, reason: `classifier error: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (classification.isMutative) {
        return { allowed: false, reason: `mutative call refused: ${classification.reason}` };
    }
    if (!classification.matchedRule) {
        return { allowed: false, reason: `${name} is not on the verified read-only list` };
    }
    return { allowed: true, reason: classification.reason };
}

/** Drop everything a sub-agent may not call, before the model ever sees it. */
export function filterReadOnlyTools<T extends { name: string }>(tools: T[]): T[] {
    return tools.filter(tool => {
        // Lowercased for the same reason as isReadOnlyForSubagent above — the
        // filtered list and the runtime re-check must agree on case handling.
        const lower = tool.name.toLowerCase();
        if (SUBAGENT_TOOL_DENYLIST.has(lower)) return false;
        // Bash-like tools are judged per call (the command string decides), so keep
        // them in the list and let the runtime check gate each invocation.
        if (lower === 'execute_command') return true;
        return isReadOnlyForSubagent(tool.name).allowed;
    });
}

function buildSystemPrompt(spec: SubagentSpec): SystemMessage {
    return new SystemMessage(`You are a focused read-only investigator working as a sub-agent for a cloud-operations platform.

## Your role
${spec.role}

## Your task
${spec.task}

## What to return
${spec.expectedOutput}

## Constraints

- You are READ-ONLY. You cannot create, modify, delete, start, stop, or write anything. If the task appears to need a change, do NOT attempt it — describe the recommended change in your findings and the main agent will carry it out under human approval.
- You cannot ask the user questions. If something is ambiguous, investigate the most likely interpretation and say what you assumed.
- You see none of the parent conversation. Everything you need is in the task above.
- Batch independent read-only calls into a single turn — they run in parallel.

## Output

When you have gathered enough, reply with your findings as plain text. No preamble, no narration of what you did. Structure it as:

**Findings** — what you established, with concrete evidence (resource ids, metric values, region and account names).
**Could not determine** — anything you could not establish, and why. Write "Nothing" if everything was resolved.

Be dense. Your reply is consumed by another agent, not a human.`);
}

function finishReport(text: string, note?: string): string {
    const body = text.trim() || '(no findings produced)';
    const withNote = note ? `${body}\n\n[${note}]` : body;
    return withNote.length > SUBAGENT_REPORT_MAX_CHARS
        ? `${withNote.slice(0, SUBAGENT_REPORT_MAX_CHARS)}\n\n[TRUNCATED — report exceeded ${SUBAGENT_REPORT_MAX_CHARS} characters]`
        : withNote;
}

async function runSubagentLoop(spec: SubagentSpec, deps: SubagentDeps): Promise<SubagentResult> {
    const { budget } = deps;
    const allowedTools = filterReadOnlyTools(deps.tools);
    const toolsByName = new Map(allowedTools.map(t => [t.name, t]));

    const boundModel = deps.model.bindTools
        ? (deps.model.bindTools(allowedTools) as SubagentDeps['model'])
        : deps.model;

    const messages: unknown[] = [buildSystemPrompt(spec), new HumanMessage({ content: spec.task })];
    const transcript: SubagentTranscriptEntry[] = [];

    let toolCount = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let lastText = '';

    for (let iteration = 0; iteration < budget.subagentMaxIterations; iteration++) {
        const response = (await boundModel.invoke(messages)) as {
            content: unknown;
            tool_calls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>;
            usage_metadata?: { input_tokens?: number; output_tokens?: number };
        };

        tokensIn += response.usage_metadata?.input_tokens ?? 0;
        tokensOut += response.usage_metadata?.output_tokens ?? 0;

        const text = contentToText(response.content);
        if (text.trim()) {
            lastText = text;
            transcript.push({ kind: 'ai', text });
        }

        const toolCalls = response.tool_calls ?? [];
        if (toolCalls.length === 0) {
            deps.onEvent?.({ toolCount, tokensIn, tokensOut });
            return { report: finishReport(lastText), toolCount, tokensIn, tokensOut, status: 'done', transcript };
        }

        messages.push(new AIMessage({ content: text, tool_calls: toolCalls as never }));

        // Independent calls in one turn run concurrently — the same parallelism
        // the orchestrator gets from ToolNode.
        const results = await Promise.all(toolCalls.map(async call => {
            const verdict = isReadOnlyForSubagent(call.name, call.args ?? {});
            if (!verdict.allowed) {
                return {
                    call,
                    output: `REFUSED: ${verdict.reason}. You cannot mutate state. Report the recommended change in your findings; the main agent will execute it under human approval.`,
                };
            }

            const tool = toolsByName.get(call.name);
            if (!tool) {
                return { call, output: `REFUSED: ${call.name} is not available to sub-agents.` };
            }

            try {
                const raw = await tool.invoke(call.args ?? {});
                return { call, output: truncateOutput(typeof raw === 'string' ? raw : JSON.stringify(raw), SUBAGENT_TOOL_OUTPUT_MAX_CHARS) };
            } catch (error) {
                // A failing tool is data, not a crash — the sub-agent should report it.
                return { call, output: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
            }
        }));

        for (const { call, output } of results) {
            if (!output.startsWith('REFUSED:')) toolCount++;
            transcript.push({ kind: 'tool', name: call.name, text: output });
            messages.push(new ToolMessage({ content: output, tool_call_id: call.id ?? `${call.name}-${toolCount}` }));
        }

        deps.onEvent?.({ toolCount, tokensIn, tokensOut });
    }

    return {
        report: finishReport(lastText, `INCOMPLETE — the sub-agent reached its ${budget.subagentMaxIterations}-iteration limit. Findings above are partial.`),
        toolCount, tokensIn, tokensOut, status: 'done', transcript,
    };
}

/**
 * Run one sub-agent. Never throws: every failure path returns a report string,
 * because a sub-agent failure must not abort the orchestrator's run.
 */
export async function runSubagent(spec: SubagentSpec, deps: SubagentDeps): Promise<SubagentResult> {
    const timeoutMs = deps.budget.subagentTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
        const outcome = await Promise.race([runSubagentLoop(spec, deps), timeout]);
        if (outcome === 'timeout') {
            return {
                report: finishReport('', `TIMED OUT after ${Math.round(timeoutMs / 1000)}s — no findings were returned in time.`),
                toolCount: 0, tokensIn: 0, tokensOut: 0, status: 'failed', transcript: [],
            };
        }
        return outcome;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Subagent] "${spec.role}" failed: ${message}`);
        return {
            report: finishReport('', `FAILED — ${message}`),
            toolCount: 0, tokensIn: 0, tokensOut: 0, status: 'failed', transcript: [],
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

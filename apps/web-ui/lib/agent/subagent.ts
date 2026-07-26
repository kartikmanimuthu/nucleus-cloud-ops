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
 * Shell commands are ALLOWLISTED, not blocklisted.
 *
 * classifyTool treats any bash-like call that misses its mutative regexes as
 * "read-only bash command" WITH matchedRule: true — so the fail-closed
 * !matchedRule rule never fires for shell. That is adequate for the guard node
 * (a human reviews the call) but not here: a sub-agent runs inside a tool call,
 * which LangGraph cannot interrupt, so nothing downstream can stop the command.
 *
 * An adversarial review escaped the blocklist 23 ways — a flag before the
 * service name, a quote around the verb, a verb missing from the list, or simply
 * a different binary (pulumi, psql, python3). Enumerating mutations is
 * unwinnable; enumerating the reads we actually need is not.
 */
const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'run_command', 'execute_command']);

/** Metacharacters that allow chaining, substitution, or redirection out of the allowlist. */
const SHELL_METACHAR = /[;&|`$><\n\r]/;

/** Binaries a sub-agent may invoke at all. */
const ALLOWED_SHELL_BINARIES = new Set([
    'aws', 'kubectl', 'cat', 'ls', 'grep', 'head', 'tail', 'wc', 'jq', 'echo',
]);

/** AWS operation prefixes that are read-only by CLI convention. */
const READ_ONLY_AWS_OP_PREFIX = /^(describe|list|get|head|search|lookup|check|batch-get)-/;

/** Read-only AWS operations that do not follow the prefix convention. */
const READ_ONLY_AWS_OP_EXACT = new Set(['ls', 'filter-log-events', 'query', 'scan', 'help']);

/** Read-only kubectl verbs. */
const READ_ONLY_KUBECTL_VERBS = new Set([
    'get', 'describe', 'logs', 'top', 'version', 'api-resources', 'explain',
]);

/** Strip one layer of surrounding quotes: `aws ec2 "terminate-instances"` must not hide the verb. */
function unquote(token: string): string {
    return token.replace(/^['"]|['"]$/g, '');
}

/**
 * Resolve the command string from a bash-like tool's args. Returns null when the
 * args carry no usable command — an array, a number, an empty object. classifyTool
 * fails open on `{}` and stringifies an array into a comma-joined string that
 * matches no pattern, so both must be refused here.
 */
export function resolveShellCommand(args?: Record<string, unknown>): string | null {
    for (const key of ['command', 'cmd', 'input']) {
        const value = args?.[key];
        if (typeof value === 'string' && value.trim().length > 0) return value;
        if (value !== undefined) return null; // present but not a usable string
    }
    return null;
}

/** Allowlist verdict for one shell command string. */
export function isReadOnlyShellCommand(cmd: string): { allowed: boolean; reason: string } {
    if (SHELL_METACHAR.test(cmd)) {
        return { allowed: false, reason: 'command contains shell metacharacters (chaining, substitution, or redirection)' };
    }

    // Quotes are stripped per token, so splitting on whitespace is sufficient once
    // metacharacters are already refused.
    const tokens = cmd.trim().split(/\s+/).map(unquote).filter(t => t.length > 0);
    // Drop leading VAR=value assignments (`AWS_PROFILE=x aws ...`).
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    if (tokens.length === 0) return { allowed: false, reason: 'empty command' };

    const binary = tokens[0];
    if (!ALLOWED_SHELL_BINARIES.has(binary)) {
        return { allowed: false, reason: `binary "${binary}" is not on the sub-agent read-only allowlist` };
    }

    if (binary === 'aws') {
        // Walk past global flags AND their values to find <service> then <operation>.
        // This is what defeated the old regex: it assumed `aws <service> <verb>` adjacency.
        const positional: string[] = [];
        for (let i = 1; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.startsWith('-')) {
                // A flag's value is the next token when it is not itself a flag.
                if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++;
                continue;
            }
            positional.push(token);
            if (positional.length === 2) break;
        }
        const operation = positional[1];
        if (!operation) return { allowed: false, reason: 'aws command has no resolvable operation' };
        if (!READ_ONLY_AWS_OP_PREFIX.test(operation) && !READ_ONLY_AWS_OP_EXACT.has(operation)) {
            return { allowed: false, reason: `aws operation "${operation}" is not a verified read-only operation` };
        }
        return { allowed: true, reason: `aws read-only operation "${operation}"` };
    }

    if (binary === 'kubectl') {
        const verb = tokens.slice(1).find(t => !t.startsWith('-'));
        if (!verb || !READ_ONLY_KUBECTL_VERBS.has(verb)) {
            return { allowed: false, reason: `kubectl verb "${verb ?? '(none)'}" is not read-only` };
        }
        return { allowed: true, reason: `kubectl read-only verb "${verb}"` };
    }

    return { allowed: true, reason: `read-only utility "${binary}"` };
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

    // Shell is allowlisted here rather than delegated to classifyTool, whose
    // bash handling is a blocklist that reports matchedRule: true on a miss.
    if (SHELL_TOOL_NAMES.has(name.toLowerCase())) {
        const cmd = resolveShellCommand(args);
        if (cmd === null) {
            return { allowed: false, reason: `${name} called without a usable command string` };
        }
        const verdict = isReadOnlyShellCommand(cmd);
        return verdict.allowed
            ? { allowed: true, reason: verdict.reason }
            : { allowed: false, reason: `shell call refused: ${verdict.reason}` };
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

/**
 * Cancellation token plus shared progress. `Promise.race` abandons the loop but
 * cannot stop it: measured, an orphaned loop ran 8 more model calls and 9 more
 * tool calls against customer AWS after `runSubagent` had already returned —
 * tokens no budget could see, with the concurrency semaphore already released.
 * `progress` also lets the timeout path report real usage instead of zeros.
 */
interface SubagentControl {
    cancelled: boolean;
    progress: { toolCount: number; tokensIn: number; tokensOut: number };
}

async function runSubagentLoop(
    spec: SubagentSpec,
    deps: SubagentDeps,
    control: SubagentControl,
): Promise<SubagentResult> {
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

    /** Report the partial findings gathered before cancellation landed. */
    const cancelledResult = (): SubagentResult => ({
        report: finishReport(lastText, 'CANCELLED — the sub-agent exceeded its time limit. Findings above are partial.'),
        toolCount, tokensIn, tokensOut, status: 'done', transcript,
    });

    for (let iteration = 0; iteration < budget.subagentMaxIterations; iteration++) {
        if (control.cancelled) return cancelledResult();

        const response = (await boundModel.invoke(messages)) as {
            content: unknown;
            tool_calls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>;
            usage_metadata?: { input_tokens?: number; output_tokens?: number };
        };

        tokensIn += response.usage_metadata?.input_tokens ?? 0;
        tokensOut += response.usage_metadata?.output_tokens ?? 0;
        control.progress.tokensIn = tokensIn;
        control.progress.tokensOut = tokensOut;

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
                    executed: false,
                    output: `REFUSED: ${verdict.reason}. You cannot mutate state. Report the recommended change in your findings; the main agent will execute it under human approval.`,
                };
            }

            const tool = toolsByName.get(call.name);
            if (!tool) {
                return { call, executed: false, output: `REFUSED: ${call.name} is not available to sub-agents.` };
            }

            // Second checkpoint: cancellation must stop work that has not started
            // yet, not merely the next lap.
            if (control.cancelled) {
                return { call, executed: false, output: 'REFUSED: the sub-agent was cancelled before this call ran.' };
            }

            try {
                const raw = await tool.invoke(call.args ?? {});
                return { call, executed: true, output: truncateOutput(typeof raw === 'string' ? raw : JSON.stringify(raw), SUBAGENT_TOOL_OUTPUT_MAX_CHARS) };
            } catch (error) {
                // A failing tool is data, not a crash — the sub-agent should report it.
                return { call, executed: true, output: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
            }
        }));

        for (const { call, executed, output } of results) {
            // Counted from the verdict, not from the output text: a real tool whose
            // output happens to begin with "REFUSED:" (an echoed IAM denial) is a
            // call that actually ran and must be billed as one.
            if (executed) toolCount++;
            transcript.push({ kind: 'tool', name: call.name, text: output });
            messages.push(new ToolMessage({ content: output, tool_call_id: call.id ?? `${call.name}-${toolCount}` }));
        }

        control.progress.toolCount = toolCount;
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
    const control: SubagentControl = { cancelled: false, progress: { toolCount: 0, tokensIn: 0, tokensOut: 0 } };
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        // Read inside the try: a malformed deps.budget must not throw out of a
        // function whose contract is that it never throws.
        const timeoutMs = deps.budget.subagentTimeoutMs;

        const timeout = new Promise<'timeout'>(resolve => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
        });

        const outcome = await Promise.race([runSubagentLoop(spec, deps, control), timeout]);
        if (outcome === 'timeout') {
            control.cancelled = true;
            return {
                report: finishReport('', `TIMED OUT after ${Math.round(timeoutMs / 1000)}s — no findings were returned in time.`),
                toolCount: control.progress.toolCount,
                tokensIn: control.progress.tokensIn,
                tokensOut: control.progress.tokensOut,
                status: 'failed', transcript: [],
            };
        }
        return outcome;
    } catch (error) {
        control.cancelled = true;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Subagent] "${spec.role}" failed: ${message}`);
        return {
            report: finishReport('', `FAILED — ${message}`),
            toolCount: control.progress.toolCount,
            tokensIn: control.progress.tokensIn,
            tokensOut: control.progress.tokensOut,
            status: 'failed', transcript: [],
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

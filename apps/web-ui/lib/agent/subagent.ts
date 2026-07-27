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
import { hasSubagentReadOnlyMarker } from './subagent-tool-marker';
import { contentToText, truncateOutput } from './agent-shared';
import type { SubagentBudgetConfig } from './subagent-budget';
import { redactTranscript } from './subagent-redact';

/** ~1500 tokens. Enforced in characters so the bound is deterministic and testable. */
export const SUBAGENT_REPORT_MAX_CHARS = 6000;

/** Per-tool output cap inside a sub-agent — it never leaves this context. */
const SUBAGENT_TOOL_OUTPUT_MAX_CHARS = 4000;

/**
 * Never available to a sub-agent, regardless of what classifyTool says.
 * - dispatch_agent: depth cap of 1; recursion makes cost and latency unbounded.
 * - ask_user: pauses for a human, and no human is reachable inside a tool call.
 * - shell: two designs for gating a command string were escaped (the second to RCE
 *   via `s3api get-object` writing an arbitrary local path, then LD_PRELOAD). A
 *   sub-agent reaches AWS through the structured aws_read tool instead, which builds
 *   argv itself and never invokes a shell.
 */
const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'run_command', 'execute_command']);
const SUBAGENT_TOOL_DENYLIST = new Set([
    'dispatch_agent', 'ask_user', ...SHELL_TOOL_NAMES,
]);

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
 *
 * `instance` is the ACTUAL tool object about to be invoked. Tools built for
 * sub-agents (aws_read) are safe by their own implementation rather than by
 * anything classifyTool knows about their name — classifyTool matches no rule for
 * them, so without an exemption the fail-closed branch refuses them on every call.
 * That exemption is bound to the instance's marker, never to its name: MCP tool
 * names arrive unprefixed from tenant-configured servers (mcp-manager.ts), so a
 * name-based exemption is a claim any remote server can make. A bare-string call
 * therefore gets NO exemption — `isReadOnlyForSubagent('aws_read')` is false.
 *
 * The exemption lives here rather than in tool-classifier.ts because the guard
 * node's human-approval path depends on the classifier's current behaviour.
 */
export function isReadOnlyForSubagent(
    name: string,
    args?: Record<string, unknown>,
    instance?: unknown,
): { allowed: boolean; reason: string } {
    // Lowercased: classifyTool() lowercases internally, so once Task 8 adds
    // dispatch_agent to its READ_ONLY_ALLOWLIST a case variant like
    // "Dispatch_Agent" would miss a case-SENSITIVE denylist and then be waved
    // through as allowlisted-read-only. The tool-name lookup below would still
    // catch it, but a safety boundary must not depend on its own backstop.
    if (SUBAGENT_TOOL_DENYLIST.has(name.toLowerCase())) {
        return { allowed: false, reason: `${name} is not available to sub-agents` };
    }

    // After the denylist, never before: a denied name must stay denied even if the
    // instance were somehow also marked.
    if (hasSubagentReadOnlyMarker(instance)) {
        return { allowed: true, reason: 'sub-agent read-only tool (marked instance)' };
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

/**
 * Drop everything a sub-agent may not call, before the model ever sees it.
 *
 * Delegates wholly to `isReadOnlyForSubagent` so the two layers cannot disagree:
 * this function previously hardcoded `execute_command` as a keep-and-gate-later
 * exception, which is exactly the special case the shell removal deleted.
 *
 * The tool OBJECT is passed through, not just its name: the aws_read exemption is
 * bound to the instance marker, so an impostor named `aws_read` is dropped here
 * (and therefore never reaches `toolsByName`, where last-wins would have let it
 * shadow the real tool).
 */
export function filterReadOnlyTools<T extends { name: string }>(tools: T[]): T[] {
    return tools.filter(tool => isReadOnlyForSubagent(tool.name, undefined, tool).allowed);
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
- You have NO shell. Reach AWS only through aws_read, giving the service and operation separately. Call get_aws_credentials first to obtain a profile name.
- Batch independent aws_read calls into a single turn — they run in parallel.
- If aws_read refuses an operation you need, report that in your findings; do not try to work around it.

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
            // The verdict is taken on the instance that will actually be invoked —
            // `toolsByName` holds only tools that already passed the filter, so a
            // marker-less impostor is never in here to be exempted.
            const tool = toolsByName.get(call.name);
            const verdict = isReadOnlyForSubagent(call.name, call.args ?? {}, tool);
            if (!verdict.allowed) {
                return {
                    call,
                    executed: false,
                    output: `REFUSED: ${verdict.reason}. You cannot mutate state. Report the recommended change in your findings; the main agent will execute it under human approval.`,
                };
            }

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
                const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
                return {
                    call,
                    executed: true,
                    output: truncateOutput(text, SUBAGENT_TOOL_OUTPUT_MAX_CHARS),
                    // Redact BEFORE truncating. Truncated JSON no longer parses, which
                    // silently downgrades redaction to its weaker regex path — and that
                    // path has no location-based `Environment.Variables` rule. A real
                    // `get-function-configuration` exceeds the cap routinely, so
                    // truncate-first would make the weak path the COMMON path.
                    //
                    // Only the persisted transcript is redacted. The model-visible copy
                    // above stays raw: the location rule blanks every value under
                    // `Variables`, benign ones included, which is right for at-rest
                    // storage and wrong for a live agent that must still answer
                    // questions about the configuration it just read.
                    transcriptText: truncateOutput(redactTranscript(text), SUBAGENT_TOOL_OUTPUT_MAX_CHARS),
                };
            } catch (error) {
                // A failing tool is data, not a crash — the sub-agent should report it.
                // The message can echo the arguments, so it is redacted like any output.
                const message = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
                return { call, executed: true, output: message, transcriptText: redactTranscript(message) };
            }
        }));

        for (const { call, executed, output, transcriptText } of results) {
            // Counted from the verdict, not from the output text: a real tool whose
            // output happens to begin with "REFUSED:" (an echoed IAM denial) is a
            // call that actually ran and must be billed as one.
            if (executed) toolCount++;
            transcript.push({ kind: 'tool', name: call.name, text: transcriptText ?? output });
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

import { pendingToolCallsOf } from '@/lib/agent/guard';
import { extractJsonObject } from '@/lib/agent/llm-json';
import type { GuardVerdict, PlanStep, ReflectionState } from '@/lib/agent/agent-shared';

export interface DataPart { type: `data-${string}`; id?: string; data: unknown }

export function buildPlanPart(threadId: string, steps: PlanStep[], updatedBy: string): DataPart {
    return { type: 'data-plan', id: `plan-${threadId}`, data: { steps, updatedBy } };
}

export function buildPhasePart(phase: string, node: string): DataPart {
    return { type: 'data-phase', data: { phase, node, ts: Date.now() } };
}

/**
 * One data-memory part per memory model run (recall or save). `count` is the
 * number of markdown bullet lines in the accumulated summary (matches
 * `/^[-*•]\s/m`), or null when the summary reads as prose (no bullets).
 */
export function buildMemoryPart(op: 'recall' | 'save', summary: string): DataPart {
    const bulletMatches = summary.match(/^[-*•]\s/gm);
    const count = bulletMatches ? bulletMatches.length : null;
    return { type: 'data-memory', data: { op, summary, count } };
}

// Exact markers from planning-agent.ts's reflectNode `feedback` template (do not
// change independently of that template):
//   `🔍 **Reflection Analysis:**\n${analysis}\n\n` +
//   `${issues !== "None" ? \`⚠️ **Issues Found:** ${issues}\` : ""}\n` +
//   `${suggestions !== "None" ? \`💡 **Suggestions:** ${suggestions}\` : ""}\n\n` +
//   `**Task Complete:** ${isComplete ? "✅ Yes" : "❌ No, continuing..."}`
const REFLECTION_ANALYSIS_MARKER = '🔍 **Reflection Analysis:**';
const REFLECTION_ISSUES_MARKER = '⚠️ **Issues Found:**';
const REFLECTION_SUGGESTIONS_MARKER = '💡 **Suggestions:**';
const REFLECTION_TASK_COMPLETE_MARKER = '**Task Complete:**';

// Keys that only ever appear on the reflector's own JSON payload. Used to reject
// an unrelated `{...}` span embedded in ordinary prose from being parsed as if it
// were reflector output (JSON.parse would happily succeed on `{"foo":"bar"}`).
const REFLECTOR_JSON_KEYS = ['analysis', 'isComplete', 'issues', 'suggestions', 'updatedPlan'] as const;

function hasReflectorShape(obj: Record<string, unknown>): boolean {
    return REFLECTOR_JSON_KEYS.some((key) => key in obj);
}

/**
 * reflectNode (planning-agent.ts) persists its ALREADY-FORMATTED feedback string
 * as the AIMessage content — never raw JSON — so this is the shape `humanizeReflection`
 * sees at persistence time. Convert it to the same `analysis` + `Issues:` + `Next:`
 * prose the JSON path produces, so history replay matches the live stream. Returns
 * `null` when the analysis marker isn't present (not this format).
 */
function normalizeReflectNodeFeedback(raw: string): string | null {
    const analysisIdx = raw.indexOf(REFLECTION_ANALYSIS_MARKER);
    if (analysisIdx === -1) return null;

    const afterAnalysis = analysisIdx + REFLECTION_ANALYSIS_MARKER.length;
    const issuesIdx = raw.indexOf(REFLECTION_ISSUES_MARKER, afterAnalysis);
    const suggestionsIdx = raw.indexOf(REFLECTION_SUGGESTIONS_MARKER, afterAnalysis);
    const taskCompleteIdx = raw.indexOf(REFLECTION_TASK_COMPLETE_MARKER, afterAnalysis);

    // The analysis section runs up to whichever of the three markers appears next —
    // any of them may be absent (planning-agent omits the Issues/Suggestions marker
    // lines entirely when the reflector reported "None").
    const analysisEnd = Math.min(
        ...[issuesIdx, suggestionsIdx, taskCompleteIdx, raw.length].filter((i) => i !== -1),
    );
    let prose = raw.slice(afterAnalysis, analysisEnd).trim();

    if (issuesIdx !== -1) {
        const issuesEnd = Math.min(
            ...[suggestionsIdx, taskCompleteIdx, raw.length].filter((i) => i !== -1 && i > issuesIdx),
        );
        const issues = raw.slice(issuesIdx + REFLECTION_ISSUES_MARKER.length, issuesEnd).trim();
        if (issues && !/^none/i.test(issues)) {
            prose += `\n\nIssues: ${issues}`;
        }
    }

    if (suggestionsIdx !== -1) {
        const suggestionsEnd = taskCompleteIdx !== -1 && taskCompleteIdx > suggestionsIdx ? taskCompleteIdx : raw.length;
        const suggestions = raw.slice(suggestionsIdx + REFLECTION_SUGGESTIONS_MARKER.length, suggestionsEnd).trim();
        if (suggestions) {
            prose += `\n\nNext: ${suggestions}`;
        }
    }

    return prose;
}

/**
 * The reflector node streams raw JSON (`{ isComplete, analysis, issues,
 * suggestions, updatedPlan }`) live, sometimes wrapped in ```json fences or
 * preceded by leading prose; reflectNode then persists an ALREADY-FORMATTED
 * feedback string (see `normalizeReflectNodeFeedback` above) as the AIMessage
 * content, never that raw JSON. Neither shape must ever reach the client/history
 * verbatim as a "reasoning" block — both read as broken JSON or a bespoke emoji
 * template, not thought. Try the feedback-string format first; otherwise extract
 * the first `{` … last `}` span, parse it (rejecting an unrelated embedded object
 * that happens to parse but has none of the reflector's keys), and render prose:
 * `analysis`, plus an `Issues:` line (omitted when empty, missing, or starts with
 * "None") and a `Next:` line (omitted when empty or missing). Any parse failure
 * returns `raw` unchanged so callers never lose the underlying text.
 */
export function humanizeReflection(raw: string): string {
    const feedbackProse = normalizeReflectNodeFeedback(raw);
    if (feedbackProse !== null) return feedbackProse;

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return raw;

    let parsed: { analysis?: unknown; issues?: unknown; suggestions?: unknown };
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
        return raw;
    }

    if (typeof parsed !== 'object' || parsed === null || !hasReflectorShape(parsed)) {
        return raw;
    }

    const analysis = typeof parsed.analysis === 'string' ? parsed.analysis : '';
    let prose = analysis;

    const issues = typeof parsed.issues === 'string' ? parsed.issues.trim() : '';
    if (issues && !/^none/i.test(issues)) {
        prose += `\n\nIssues: ${issues}`;
    }

    const suggestions = typeof parsed.suggestions === 'string' ? parsed.suggestions.trim() : '';
    if (suggestions) {
        prose += `\n\nNext: ${suggestions}`;
    }

    return prose;
}

/**
 * The planner node's model output IS the plan itself — a raw JSON array of
 * step strings (sometimes fenced, sometimes wrapped in a `{ "plan": [...] }`
 * object), streamed token-by-token. That must never reach the client verbatim
 * as a "thinking" block (it reads as broken JSON, and the plan already renders
 * structured in the run rail via the data-plan part). Convert it to a short
 * numbered-list prose summary; any parse failure returns `raw` unchanged so
 * genuine planner prose still shows.
 */
export function humanizePlanning(raw: string): string {
    const cleaned = raw.replace(/```(?:json)?/gi, '').trim();

    let steps: string[] | null = null;

    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd > arrStart) {
        try {
            const parsed = JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
            if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((s) => typeof s === 'string')) {
                steps = parsed;
            }
        } catch {
            // not a bare array — try the object shape below
        }
    }

    if (!steps) {
        const objStart = cleaned.indexOf('{');
        const objEnd = cleaned.lastIndexOf('}');
        if (objStart !== -1 && objEnd > objStart) {
            try {
                const parsed = JSON.parse(cleaned.slice(objStart, objEnd + 1)) as { plan?: unknown };
                if (Array.isArray(parsed.plan) && parsed.plan.length > 0 && parsed.plan.every((s) => typeof s === 'string')) {
                    steps = parsed.plan as string[];
                }
            } catch {
                // not the object shape either — fall through to raw
            }
        }
    }

    if (!steps) return raw;
    return `Drafted a ${steps.length}-step plan:\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
}

/**
 * The working-memory compaction call (foldWorkingMemory in
 * lib/agent/memory/working-memory.ts) runs the reflector model INSIDE a graph
 * node, so its output — a bare `{"summary": …, "scratchpad": …}` JSON object,
 * sometimes fenced — streams under that node's phase like any other model run.
 * It's internal bookkeeping, never something to show the user. True when the
 * run's whole output is such a payload (allowing only negligible framing text).
 */
export function isWorkingMemoryPayload(raw: string): boolean {
    const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) return false;
    const obj = extractJsonObject(cleaned.slice(start, end + 1));
    if (!obj || !('summary' in obj) || !('scratchpad' in obj)) return false;
    const remainder = (cleaned.slice(0, start) + cleaned.slice(end + 1)).trim();
    return remainder.length < 40;
}

/**
 * Some answer runs prepend their working-memory snapshot as a fenced JSON
 * block before the actual response. Strip that prelude (only when it really
 * is a WM payload) so the visible answer starts at the prose.
 */
export function stripWorkingMemoryPrelude(raw: string): string {
    const match = raw.match(/^\s*```(?:json)?\s*(\{[\s\S]*?\})\s*```\s*/);
    if (!match) return raw;
    const obj = extractJsonObject(match[1]);
    if (obj && 'summary' in obj && 'scratchpad' in obj) return raw.slice(match[0].length);
    return raw;
}

/**
 * Parts describing a parked approval_gate interrupt: one data-approval batch
 * for normal tools (each row carrying its guard verdict) and one
 * data-clarification per pending ask_user call.
 */
export function buildInterruptParts(
    values: Pick<ReflectionState, 'messages' | 'guardVerdicts'>,
    threadId: string,
): DataPart[] {
    const pending = pendingToolCallsOf(values);
    if (pending.length === 0) return [];
    const verdicts: Record<string, GuardVerdict> = values.guardVerdicts ?? {};
    const approvalTools: unknown[] = [];
    const clarificationParts: DataPart[] = [];

    for (const call of pending) {
        if (call.name === 'ask_user') {
            clarificationParts.push({
                type: 'data-clarification',
                id: `clarify-${call.id}`,
                data: {
                    toolCallId: call.id,
                    question: String(call.args.question ?? 'The agent needs your input.'),
                    options: Array.isArray(call.args.options) ? call.args.options.map(String) : [],
                },
            });
        } else {
            approvalTools.push({
                toolCallId: call.id,
                toolName: call.name,
                args: call.args,
                guard: verdicts[call.id] ?? null,
            });
        }
    }

    const parts: DataPart[] = [];
    // Order matters: deriveRunState resets stale clarifications when a data-approval
    // arrives, so the approval part must precede clarifications from the SAME interrupt.
    //
    // The data-approval part is ALWAYS emitted while anything is pending — even for
    // an ask_user-only interrupt (`tools: []`). Without it, the PREVIOUS turn's
    // data-approval would remain the last batch in deriveRunState and its
    // already-decided tools would resurrect as pendingApproval, deadlocking the
    // clarification submit (every pending id needs a decision). An empty-tools
    // batch renders nothing (pendingApproval requires unresolved tools) but resets
    // both the stale batch and stale clarification ordering.
    parts.push({
        type: 'data-approval',
        id: `approval-${threadId}`,
        data: { batchId: `batch-${threadId}-${Date.now()}`, tools: approvalTools },
    });
    parts.push(...clarificationParts);
    return parts;
}

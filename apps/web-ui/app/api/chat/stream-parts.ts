import { pendingToolCallsOf } from '@/lib/agent/guard';
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

/**
 * The reflector node emits raw JSON (`{ isComplete, analysis, issues,
 * suggestions, updatedPlan }`), sometimes wrapped in ```json fences or preceded
 * by leading prose. This must never reach the client verbatim as a "reasoning"
 * block — it reads as broken JSON, not thought. Extract the first `{` … last
 * `}` span, parse it, and render prose: `analysis`, plus an `Issues:` line
 * (omitted when empty, missing, or starts with "None") and a `Next:` line
 * (omitted when empty or missing). Any parse failure returns `raw` unchanged
 * so callers never lose the underlying text.
 */
export function humanizeReflection(raw: string): string {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return raw;

    let parsed: { analysis?: unknown; issues?: unknown; suggestions?: unknown };
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
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

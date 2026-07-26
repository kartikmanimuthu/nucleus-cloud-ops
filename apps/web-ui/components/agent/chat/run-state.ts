// Pure derivation of live run state from typed message data parts.
// One source of truth for the run rail, the timeline, and the decision cards.

export interface RunPlanStep { step: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }
export interface RunGuardVerdict {
    toolCallId: string; toolName: string; isMutative: boolean;
    severity: 'LOW' | 'MEDIUM' | 'HIGH'; action: string; blastRadius: string;
    reversible: boolean; saferPath: string;
}
export interface PendingApprovalTool {
    toolCallId: string; toolName: string; args: Record<string, unknown>;
    guard: RunGuardVerdict | null;
}
export interface PendingClarification { toolCallId: string; question: string; options: string[] }

export interface SubagentState {
    id: string;
    role: string;
    task: string;
    status: 'running' | 'done' | 'failed';
    toolCount: number;
    tokensIn: number;
    tokensOut: number;
    summary?: string;
}

export interface RunState {
    plan: RunPlanStep[];
    planUpdatedBy: string | null;
    currentPhase: string;
    phases: Array<{ phase: string; node: string; ts: number }>;
    pendingApproval: { batchId: string; tools: PendingApprovalTool[] } | null;
    pendingClarifications: PendingClarification[];
    hasStructuredData: boolean;
    /** True when ANY data-approval part was seen in the thread — such threads use
     *  Mission Control batch cards, never the legacy inline per-tool Confirmation. */
    hasApprovalData: boolean;
    /** Cumulative billed token totals summed from every data-usage part in the thread. */
    tokenUsage: { input: number; output: number };
    /** Sub-agents dispatched in this thread, in first-seen order. Later parts for
     *  the same id replace the earlier entry in place. */
    subagents: SubagentState[];
}

interface LoosePart { type: string; data?: any; text?: string }
interface LooseMessage { role: string; id?: string; parts?: LoosePart[] }

export function deriveRunState(
    messages: LooseMessage[],
    resolvedToolCallIds: Set<string>,
): RunState {
    let plan: RunPlanStep[] = [];
    let planUpdatedBy: string | null = null;
    const phases: RunState['phases'] = [];
    let lastApproval: { batchId: string; tools: PendingApprovalTool[] } | null = null;
    const clarifications: PendingClarification[] = [];
    let hasStructuredData = false;
    let hasApprovalData = false;
    let tokenIn = 0;
    let tokenOut = 0;
    const subagents = new Map<string, SubagentState>();
    // Tool calls with an output-bearing tool part ANYWHERE in the thread. An
    // executed / rejected / answered tool can never be pending again, no matter
    // what a stale data-approval or data-clarification part claims (defense
    // against pre-fix history and stream races). Mirrors the hasOutput
    // predicate in computeToolPartVisibility below.
    const executedIds = new Set<string>();

    for (const message of messages) {
        if (message.role !== 'assistant') continue;
        for (const part of message.parts ?? []) {
            const p = part as any;
            if (p?.toolCallId && p.type !== 'text') {
                const hasOutput =
                    (p.result !== undefined && p.result !== null) ||
                    (p.output !== undefined && p.output !== null) ||
                    p.state === 'output-available' ||
                    p.state === 'output-error';
                if (hasOutput) executedIds.add(String(p.toolCallId));
            }
            switch (part.type) {
                case 'data-plan': {
                    hasStructuredData = true;
                    const steps = Array.isArray(part.data?.steps) ? part.data.steps : [];
                    if (steps.length > 0) { plan = steps; planUpdatedBy = part.data?.updatedBy ?? null; }
                    break;
                }
                case 'data-phase': {
                    hasStructuredData = true;
                    if (part.data?.phase) phases.push({ phase: String(part.data.phase), node: String(part.data.node ?? ''), ts: Number(part.data.ts ?? 0) });
                    break;
                }
                case 'data-approval': {
                    hasStructuredData = true;
                    hasApprovalData = true;
                    const tools = Array.isArray(part.data?.tools) ? part.data.tools : [];
                    lastApproval = { batchId: String(part.data?.batchId ?? ''), tools };
                    // Answering a clarification from an earlier turn means older
                    // clarifications are stale — a new approval batch resets them.
                    clarifications.length = 0;
                    break;
                }
                case 'data-clarification': {
                    hasStructuredData = true;
                    if (part.data?.toolCallId) {
                        clarifications.push({
                            toolCallId: String(part.data.toolCallId),
                            question: String(part.data.question ?? ''),
                            options: Array.isArray(part.data.options) ? part.data.options.map(String) : [],
                        });
                    }
                    break;
                }
                case 'data-usage': {
                    tokenIn += Number(part.data?.input) || 0;
                    tokenOut += Number(part.data?.output) || 0;
                    break;
                }
                case 'data-subagent': {
                    hasStructuredData = true;
                    const id = String(part.data?.id ?? '');
                    if (!id) break;
                    // Map.set on an existing key preserves insertion order, so the
                    // card stays put as it updates from running → done.
                    subagents.set(id, {
                        id,
                        role: String(part.data?.role ?? ''),
                        task: String(part.data?.task ?? ''),
                        status: (part.data?.status === 'done' || part.data?.status === 'failed')
                            ? part.data.status : 'running',
                        toolCount: Number(part.data?.toolCount) || 0,
                        tokensIn: Number(part.data?.tokensIn) || 0,
                        tokensOut: Number(part.data?.tokensOut) || 0,
                        ...(part.data?.summary ? { summary: String(part.data.summary) } : {}),
                    });
                    break;
                }
            }
        }
    }

    const isResolved = (id: string) => resolvedToolCallIds.has(id) || executedIds.has(id);
    const unresolvedTools = (lastApproval?.tools ?? []).filter(t => !isResolved(t.toolCallId));
    const pendingApproval = lastApproval && unresolvedTools.length > 0
        ? { batchId: lastApproval.batchId, tools: unresolvedTools }
        : null;
    const pendingClarifications = clarifications.filter(c => !isResolved(c.toolCallId));

    return {
        plan,
        planUpdatedBy,
        currentPhase: phases.length > 0 ? phases[phases.length - 1].phase : 'text',
        phases,
        pendingApproval,
        pendingClarifications,
        hasStructuredData,
        hasApprovalData,
        tokenUsage: { input: tokenIn, output: tokenOut },
        subagents: Array.from(subagents.values()),
    };
}

/**
 * A tool call the user rejected. Two signals, either is sufficient:
 *  - the local batch-card decision recorded approved === false (covers the
 *    window before the resume stream materializes the synthetic tool output);
 *  - the server's synthetic tool-result part, whose text always starts with
 *    "Rejected by user" (see app/api/chat/decisions.ts).
 * Non-string results (structured tool outputs) are never rejections.
 */
export function isRejectedToolResult(
    result: unknown,
    decision?: { approved: boolean; answer?: string },
): boolean {
    if (decision?.approved === false) return true;
    return typeof result === 'string' && result.startsWith('Rejected by user');
}

/**
 * Cross-message tool-part dedupe. After an approval resume, the resumed stream
 * re-emits tool parts with the ORIGINAL tool_call_ids in a NEW assistant
 * message, leaving the pre-pause message with an input-only twin. Per
 * toolCallId, the winner is the LAST part that carries a result/output; if none
 * has output, the LAST part overall.
 *
 * Returns Map<toolCallId, winning messageId>. The winner is identified by its
 * containing message id (NOT a part index) because the AI SDK merges tool parts
 * by toolCallId within a single message, so a toolCallId appears at most once
 * per message — and the index the timeline hands to renderToolInvocation is the
 * index within the filtered work-parts array, not message.parts, so an index
 * key could never be matched reliably at render time.
 */
export function computeToolPartVisibility(messages: LooseMessage[]): Map<string, string> {
    const winner = new Map<string, string>();
    const winnerHasOutput = new Set<string>();

    for (const message of messages) {
        if (message.role !== 'assistant') continue;
        const messageId = String(message.id ?? '');
        for (const part of message.parts ?? []) {
            const p = part as any;
            const toolCallId = p?.toolCallId;
            // Mirror the render predicate (MessageRow workParts / flat loop):
            // a tool part carries a toolCallId and is not a text part.
            if (!toolCallId || p.type === 'text') continue;
            const hasOutput =
                (p.result !== undefined && p.result !== null) ||
                (p.output !== undefined && p.output !== null) ||
                p.state === 'output-available' ||
                p.state === 'output-error';
            if (hasOutput) {
                winner.set(toolCallId, messageId);
                winnerHasOutput.add(toolCallId);
            } else if (!winnerHasOutput.has(toolCallId)) {
                winner.set(toolCallId, messageId);
            }
        }
    }
    return winner;
}

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

export interface RunState {
    plan: RunPlanStep[];
    planUpdatedBy: string | null;
    currentPhase: string;
    phases: Array<{ phase: string; node: string; ts: number }>;
    pendingApproval: { batchId: string; tools: PendingApprovalTool[] } | null;
    pendingClarifications: PendingClarification[];
    hasStructuredData: boolean;
}

interface LoosePart { type: string; data?: any; text?: string }
interface LooseMessage { role: string; parts?: LoosePart[] }

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

    for (const message of messages) {
        if (message.role !== 'assistant') continue;
        for (const part of message.parts ?? []) {
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
            }
        }
    }

    const unresolvedTools = (lastApproval?.tools ?? []).filter(t => !resolvedToolCallIds.has(t.toolCallId));
    const pendingApproval = lastApproval && unresolvedTools.length > 0
        ? { batchId: lastApproval.batchId, tools: unresolvedTools }
        : null;
    const pendingClarifications = clarifications.filter(c => !resolvedToolCallIds.has(c.toolCallId));

    return {
        plan,
        planUpdatedBy,
        currentPhase: phases.length > 0 ? phases[phases.length - 1].phase : 'text',
        phases,
        pendingApproval,
        pendingClarifications,
        hasStructuredData,
    };
}

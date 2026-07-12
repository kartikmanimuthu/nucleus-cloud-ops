import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { classifyTool } from './tool-classifier';
import type { GuardVerdict, ReflectionState } from './agent-shared';

export interface PendingToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

/**
 * The last AIMessage's tool_calls that do not yet have a ToolMessage result
 * anywhere after that message. Used by the guard node, the gate routers, and
 * the /api/chat resume handler — one definition of "pending".
 */
export function pendingToolCallsOf(state: Pick<ReflectionState, 'messages'>): PendingToolCall[] {
    const messages = state.messages ?? [];
    let lastAiIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]._getType() === 'ai') { lastAiIdx = i; break; }
    }
    if (lastAiIdx === -1) return [];
    const ai = messages[lastAiIdx] as AIMessage;
    const calls = (ai.tool_calls ?? []).filter(c => !!c.id);
    if (calls.length === 0) return [];
    const resolved = new Set<string>();
    for (let i = lastAiIdx + 1; i < messages.length; i++) {
        const m = messages[i] as { tool_call_id?: string };
        if (messages[i]._getType() === 'tool' && m.tool_call_id) resolved.add(m.tool_call_id);
    }
    return calls
        .filter(c => !resolved.has(c.id!))
        .map(c => ({ id: c.id!, name: c.name, args: (c.args ?? {}) as Record<string, unknown> }));
}

interface RiskModel { invoke(msgs: unknown[]): Promise<{ content: unknown }> }

const RISK_SYSTEM_PROMPT = `You are a cloud-operations safety reviewer. For each proposed tool call below, produce a risk assessment.
Respond with ONLY a JSON array, one object per tool call, in the same order:
[{ "toolCallId": "<id>", "severity": "LOW" | "MEDIUM" | "HIGH", "action": "<one sentence: what this does, naming the exact resource>", "blastRadius": "<what is affected: data loss, downstream services, cost>", "reversible": true | false, "saferPath": "<a less destructive alternative, or empty string>" }]
Severity guide: HIGH = irreversible destruction/termination/deletion or IAM/security changes; MEDIUM = reversible state changes (stop, scale, restart, config update); LOW = minor mutations (tags, non-prod writes).`;

function failClosedVerdict(call: PendingToolCall, reason: string): GuardVerdict {
    return {
        toolCallId: call.id, toolName: call.name, isMutative: true, severity: 'HIGH',
        action: `Executes ${call.name} (risk assessment unavailable)`,
        blastRadius: 'Unknown — the risk assessor failed, so worst case is assumed.',
        reversible: false, saferPath: '', reason,
    };
}

/**
 * Guard node factory. Deterministic classifier first (zero cost); one batched
 * LLM call for the mutative subset. Fail-closed on every error path.
 */
export function createGuardNode(deps: { riskModel: RiskModel }) {
    return async function guardNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const pending = pendingToolCallsOf(state);
        if (pending.length === 0) return { guardVerdicts: {} };

        const verdicts: Record<string, GuardVerdict> = {};
        const mutative: PendingToolCall[] = [];

        for (const call of pending) {
            const cls = classifyTool(call.name, call.args);
            if (!cls.isMutative || call.name === 'ask_user') {
                verdicts[call.id] = {
                    toolCallId: call.id, toolName: call.name, isMutative: false, severity: 'LOW',
                    action: '', blastRadius: '', reversible: true, saferPath: '', reason: cls.reason,
                };
            } else {
                mutative.push(call);
                verdicts[call.id] = failClosedVerdict(call, cls.reason); // placeholder until LLM refines
            }
        }

        if (mutative.length > 0) {
            try {
                const callList = mutative
                    .map(c => `- toolCallId=${c.id} tool=${c.name} args=${JSON.stringify(c.args).slice(0, 500)}`)
                    .join('\n');
                const res = await deps.riskModel.invoke([
                    new SystemMessage(RISK_SYSTEM_PROMPT),
                    new HumanMessage(`Assess these tool calls:\n${callList}`),
                ]);
                const text = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
                const jsonMatch = text.match(/\[[\s\S]*\]/);
                const parsed: Array<Record<string, unknown>> = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
                for (const item of parsed) {
                    const id = String(item.toolCallId ?? '');
                    const call = mutative.find(c => c.id === id);
                    if (!call) continue;
                    const sev = item.severity === 'LOW' || item.severity === 'MEDIUM' || item.severity === 'HIGH'
                        ? item.severity : 'HIGH';
                    verdicts[id] = {
                        toolCallId: id, toolName: call.name, isMutative: true, severity: sev,
                        action: String(item.action ?? '') || `Executes ${call.name}`,
                        blastRadius: String(item.blastRadius ?? '') || 'Unspecified',
                        reversible: item.reversible === true,
                        saferPath: String(item.saferPath ?? ''),
                        reason: verdicts[id].reason,
                    };
                }
                // Any mutative call the LLM skipped keeps its fail-closed placeholder.
            } catch (err) {
                console.warn(`[Guard] risk model failed — fail-closed HIGH for ${mutative.length} call(s):`, err);
                // placeholders already fail-closed
            }
        }

        console.log(`🛡️ [GUARD] ${pending.length} call(s): ${Object.values(verdicts).filter(v => v.isMutative).length} mutative`);
        return { guardVerdicts: verdicts };
    };
}

import { AIMessage, HumanMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import { classifyTool, type ToolClassification } from './tool-classifier';
import { contentToText, type GuardVerdict, type ReflectionState } from './agent-shared';

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

interface RiskModel { invoke(msgs: BaseMessage[]): Promise<{ content: unknown }> }

const RISK_SYSTEM_PROMPT = `You are a cloud-operations safety reviewer. For each proposed tool call below, produce a risk assessment.
Each call is labeled either "known-mutative" (already confirmed to change state — assess its risk) or "unknown" (its name matched no known pattern — first judge for yourself whether the call actually mutates state; if it is clearly read-only, report mutative:false).
Respond with ONLY a JSON array, one object per tool call, in the same order:
[{ "toolCallId": "<id>", "mutative": true | false, "severity": "LOW" | "MEDIUM" | "HIGH", "action": "<one sentence: what this does, naming the exact resource>", "blastRadius": "<what is affected: data loss, downstream services, cost>", "reversible": true | false, "saferPath": "<a less destructive alternative, or empty string>" }]
For "known-mutative" calls always report mutative:true — you are only assessing severity, not whether it mutates. For "unknown" calls, decide mutative honestly: default to true when genuinely unsure (fail closed), only report false when the call is obviously a read/describe/list operation.
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
 * LLM call for the mutative subset plus any unknown-named tools (no pattern
 * matched — the LLM judges whether those actually mutate state). Fail-closed
 * on every error path, including a throwing classifier.
 */
export function createGuardNode(deps: { riskModel: RiskModel; classifier?: typeof classifyTool }) {
    const classifier = deps.classifier ?? classifyTool;

    return async function guardNode(state: ReflectionState): Promise<Partial<ReflectionState>> {
        const pending = pendingToolCallsOf(state);
        if (pending.length === 0) return { guardVerdicts: {} };

        const verdicts: Record<string, GuardVerdict> = {};
        // Calls sent to the LLM batch: known-mutative (assess risk) and
        // unknown-named (judge mutative-or-not first, then assess risk).
        const batch: Array<{ call: PendingToolCall; known: boolean }> = [];

        for (const call of pending) {
            let cls: ToolClassification;
            try {
                cls = classifier(call.name, call.args);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                verdicts[call.id] = failClosedVerdict(call, `classifier error: ${msg}`);
                continue;
            }

            if (call.name === 'ask_user') {
                verdicts[call.id] = {
                    toolCallId: call.id, toolName: call.name, isMutative: false, severity: 'LOW',
                    action: '', blastRadius: '', reversible: true, saferPath: '', reason: cls.reason,
                };
                continue;
            }

            if (cls.matchedRule && !cls.isMutative) {
                // Explicit read-only rule hit (allowlist or bash inspection) — known-safe, no LLM.
                verdicts[call.id] = {
                    toolCallId: call.id, toolName: call.name, isMutative: false, severity: 'LOW',
                    action: '', blastRadius: '', reversible: true, saferPath: '', reason: cls.reason,
                };
                continue;
            }

            // Either matchedRule (mutative name/bash pattern hit) or unknown-named
            // (matchedRule false) — both go to the LLM batch, fail-closed until refined.
            batch.push({ call, known: !!cls.matchedRule });
            verdicts[call.id] = failClosedVerdict(call, cls.reason);
        }

        if (batch.length > 0) {
            try {
                const callList = batch
                    .map(({ call, known }) =>
                        `- toolCallId=${call.id} tool=${call.name} args=${JSON.stringify(call.args).slice(0, 500)} [${known ? 'known-mutative' : 'unknown'}]`)
                    .join('\n');
                const res = await deps.riskModel.invoke([
                    new SystemMessage(RISK_SYSTEM_PROMPT),
                    new HumanMessage(`Assess these tool calls:\n${callList}`),
                ]);
                const text = contentToText(res.content);
                const jsonMatch = text.match(/\[[\s\S]*\]/);
                const parsed: Array<Record<string, unknown>> = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
                for (const item of parsed) {
                    const id = String(item.toolCallId ?? '');
                    const entry = batch.find(b => b.call.id === id);
                    if (!entry) continue;
                    const { call, known } = entry;

                    if (known) {
                        // Server-side override: known-mutative calls stay mutative
                        // regardless of what the LLM reports for "mutative".
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
                    } else if (item.mutative === false) {
                        // Unknown-named tool the LLM judged read-only.
                        verdicts[id] = {
                            toolCallId: id, toolName: call.name, isMutative: false, severity: 'LOW',
                            action: String(item.action ?? ''), blastRadius: String(item.blastRadius ?? ''),
                            reversible: true, saferPath: '',
                            reason: `LLM judged read-only: ${verdicts[id].reason}`,
                        };
                    }
                    // Unknown call with mutative: true, missing/unparseable, or omitted
                    // entirely from the array keeps its fail-closed HIGH placeholder.
                }
                // Any batch call the LLM skipped entirely keeps its fail-closed placeholder.
            } catch (err) {
                console.warn(`[Guard] risk model failed — fail-closed HIGH for ${batch.length} call(s):`, err);
                // placeholders already fail-closed
            }
        }

        console.log(`🛡️ [GUARD] ${pending.length} call(s): ${Object.values(verdicts).filter(v => v.isMutative).length} mutative`);
        return { guardVerdicts: verdicts };
    };
}

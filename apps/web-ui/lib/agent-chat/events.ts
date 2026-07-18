// Pure reducer: AI SDK v7 UIMessage.parts -> flat TranscriptEvent[].
// Consumed by the Mission Control transcript components (later tasks). No React here.

import { isRejectedToolResult } from '@/components/agent/chat/run-state';

export type AgentPhaseName =
    | 'planning' | 'execution' | 'reflection' | 'revision' | 'final'
    | 'memory_recall' | 'memory_save' | 'text';

export type TranscriptEvent =
    | { kind: 'thinking'; id: string; phase: AgentPhaseName; text: string; streaming: boolean }
    | {
        kind: 'tool'; id: string; toolCallId: string; toolName: string; input: unknown;
        output: unknown; status: 'running' | 'done' | 'error' | 'rejected';
    }
    | { kind: 'memory'; id: string; op: 'recall' | 'save'; summary: string; count: number | null }
    | { kind: 'answer'; id: string; text: string; streaming: boolean }
    | { kind: 'image'; id: string; url: string };

interface LoosePart {
    type: string;
    data?: any;
    text?: string;
    toolCallId?: string;
    toolName?: string;
    state?: string;
    input?: unknown;
    output?: unknown;
    result?: unknown;
}

export interface LooseMessage {
    id: string;
    role: string;
    parts?: LoosePart[];
}

export interface BuildTranscriptOptions {
    isStreaming: boolean;
    toolVisibility: Map<string, string>;
    decisions: Map<string, { approved: boolean; answer?: string }>;
}

// A "decision carrier" is the empty user message sent to resume a run when the
// user decides a pending approval/clarification batch — the server acts on
// `body.decisions` before reading the last message, so the message itself needs
// no content. Hide it from the transcript so no empty user bubble lingers.
export function isEmptyDecisionCarrier(m: any): boolean {
    if (m?.role !== 'user') return false;
    const parts: any[] = m.parts || [];
    const hasText =
        parts.some((p: any) => p.type === 'text' && (p.text || '').trim().length > 0) ||
        (typeof m.content === 'string' && m.content.trim().length > 0);
    const hasAttach =
        (m.experimental_attachments?.length || 0) > 0 ||
        parts.some((p: any) => typeof p.type === 'string' && p.type.startsWith('file'));
    return !hasText && !hasAttach;
}

// Legacy inline sentinel the backend prefixes to the first reasoning chunk of a
// phase (see app/api/chat/route.ts PHASE_START markers). Structured threads
// carry the phase via data-phase parts instead, but we still defensively strip
// this from any reasoning text.
const SENTINEL_RE = /^(PLANNING|EXECUTION|REFLECTION|REVISION|FINAL|MEMORY_RECALL|MEMORY_SAVE)_PHASE_START\n?/;

function stripSentinel(text: string): string {
    return text.replace(SENTINEL_RE, '');
}

function deriveToolName(part: LoosePart): string {
    if (part.toolName) return part.toolName;
    return part.type.replace(/^tool-/, '');
}

// Mirrors the hasOutput predicate in run-state.ts's computeToolPartVisibility /
// deriveRunState — a tool part is "done" once either output field is populated,
// or the SDK marks it output-available.
function hasOutputValue(part: LoosePart): boolean {
    return (part.output !== undefined && part.output !== null)
        || (part.result !== undefined && part.result !== null)
        || part.state === 'output-available';
}

function resolveOutput(part: LoosePart): unknown {
    return part.output ?? part.result;
}

interface PendingThinking {
    id: string;
    phase: AgentPhaseName;
    text: string;
}

/**
 * Reduces one message's parts into TranscriptEvent[]. Pure — no side effects,
 * no React. See the behavior contract in the Task 1 brief for the full rules;
 * summary:
 *  - data-phase parts track the current phase, emit nothing themselves.
 *  - reasoning parts become `thinking` events (sentinel-stripped, merged while
 *    consecutive + same phase), EXCEPT under the legacy memory_recall/
 *    memory_save phases, where they become `memory` events instead.
 *  - tool parts (any part with a toolCallId, type !== 'text') become `tool`
 *    events, deduped via opts.toolVisibility (cross-message tool-part dedupe).
 *  - data-memory parts become `memory` events directly.
 *  - text parts become `answer` events (whitespace-only text is dropped).
 *  - data-plan / data-approval / data-clarification / step-start parts are
 *    rail/card-only — they emit nothing and do not interrupt a reasoning merge.
 *  - streaming is only ever true on the LAST event, and only when
 *    opts.isStreaming is set (callers only pass true for the last assistant
 *    message of the thread).
 */
export function buildTranscript(message: LooseMessage, opts: BuildTranscriptOptions): TranscriptEvent[] {
    const events: TranscriptEvent[] = [];
    let phase: AgentPhaseName = 'text';
    let pendingThinking: PendingThinking | null = null;

    const flushThinking = () => {
        if (pendingThinking && pendingThinking.text.length > 0) {
            events.push({
                kind: 'thinking',
                id: pendingThinking.id,
                phase: pendingThinking.phase,
                text: pendingThinking.text,
                streaming: false,
            });
        }
        pendingThinking = null;
    };

    const parts = message.parts ?? [];
    parts.forEach((part, index) => {
        const id = `${message.id}:${index}`;

        switch (part.type) {
            case 'data-phase': {
                if (typeof part.data?.phase === 'string') phase = part.data.phase as AgentPhaseName;
                return;
            }
            case 'data-memory': {
                flushThinking();
                events.push({
                    kind: 'memory',
                    id,
                    op: part.data?.op === 'save' ? 'save' : 'recall',
                    summary: String(part.data?.summary ?? ''),
                    count: typeof part.data?.count === 'number' ? part.data.count : null,
                });
                return;
            }
            case 'reasoning': {
                const text = stripSentinel(part.text ?? '');
                if (text.length === 0) return;

                if (phase === 'memory_recall' || phase === 'memory_save') {
                    flushThinking();
                    events.push({
                        kind: 'memory',
                        id,
                        op: phase === 'memory_save' ? 'save' : 'recall',
                        summary: text,
                        count: null,
                    });
                    return;
                }

                if (pendingThinking && pendingThinking.phase === phase) {
                    pendingThinking.text += text;
                } else {
                    flushThinking();
                    pendingThinking = { id, phase, text };
                }
                return;
            }
            case 'text': {
                const text = part.text ?? '';
                if (text.trim().length === 0) return;
                flushThinking();
                events.push({ kind: 'answer', id, text, streaming: false });
                return;
            }
            default: {
                if (part.toolCallId && part.type !== 'text') {
                    const toolCallId = String(part.toolCallId);
                    if (opts.toolVisibility.get(toolCallId) !== message.id) return;

                    flushThinking();
                    const output = resolveOutput(part);
                    const decision = opts.decisions.get(toolCallId);

                    let status: 'running' | 'done' | 'error' | 'rejected';
                    if (isRejectedToolResult(output, decision)) status = 'rejected';
                    else if (part.state === 'output-error') status = 'error';
                    else if (hasOutputValue(part)) status = 'done';
                    else status = 'running';

                    events.push({
                        kind: 'tool',
                        id: `${message.id}:tool:${toolCallId}`,
                        toolCallId,
                        toolName: deriveToolName(part),
                        input: part.input,
                        output,
                        status,
                    });
                }
                // data-plan / data-approval / data-clarification / step-start / any
                // other non-tool part: rail/card-only, emits nothing.
                return;
            }
        }
    });

    flushThinking();

    if (opts.isStreaming && events.length > 0) {
        const last = events[events.length - 1];
        if (last.kind === 'thinking' || last.kind === 'answer') {
            events[events.length - 1] = { ...last, streaming: true };
        }
    }

    return events;
}

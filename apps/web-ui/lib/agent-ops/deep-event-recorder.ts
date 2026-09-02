/**
 * Deep Event Recorder — translates deepagents runtime signals into
 * agent_ops_events rows.
 *
 * This is the DB-row analogue of app/api/chat/deep-stream.ts: that module turns
 * the same signals into AI SDK UIMessageChunks for a browser, this one turns
 * them into persisted rows the Agent Ops timeline polls.
 *
 * Deliberately pure: it takes a `sink` rather than importing the service, so the
 * whole translation layer is unit-testable with no DB. Every method swallows
 * sink failures — event recording must never abort a run.
 *
 * ORDERING: the v3 projections are consumed in parallel, so several writers can
 * land inside the same millisecond and `getRunEvents` orders by createdAt only.
 * Every row therefore carries `metadata.seq` from a per-run counter, and the
 * timeline sorts on that.
 *
 * `raw` exposes the same seq-stamping/error-swallowing `emit` used internally
 * so callers that need event kinds this recorder has no typed method for (run
 * start, cancellation, run-level error, …) still go through the single seq
 * counter — the recorder must be the sole writer, so a mixed population of
 * seq'd and un-seq'd rows never happens.
 */
import type { RecordEventParams } from './record-and-emit';

/** Tool output longer than this is truncated before persisting. */
export const MAX_TOOL_OUTPUT = 8000;

export type DeepEventSink = (params: RecordEventParams) => Promise<void>;

export interface DeepTodo {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
}

export interface DeepSubagentSnapshot {
    id: string;
    role: string;
    task: string;
    status: 'running' | 'done' | 'failed';
    toolCount: number;
    tokensIn: number;
    tokensOut: number;
    summary?: string;
}

export interface DeepPendingAction {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    interruptId: string;
    index: number;
}

export interface DeepEventRecorder {
    text(content: string, subagentId?: string): Promise<void>;
    reasoning(content: string, subagentId?: string): Promise<void>;
    toolCall(args: { toolCallId: string; toolName: string; args: Record<string, unknown>; subagentId?: string }): Promise<void>;
    toolResult(args: { toolCallId: string; toolName: string; output: string; status: 'finished' | 'error'; subagentId?: string }): Promise<void>;
    todos(todos: DeepTodo[]): Promise<void>;
    subagent(snapshot: DeepSubagentSnapshot): Promise<void>;
    memory(op: 'recall' | 'save', summary: string): Promise<void>;
    approvalGate(actions: DeepPendingAction[]): Promise<void>;
    final(content: string, metadata?: Record<string, unknown>): Promise<void>;
    raw(params: Omit<RecordEventParams, 'runId' | 'tenantId'>): Promise<void>;
}

function truncate(text: string): { output: string; truncated: boolean } {
    if (text.length <= MAX_TOOL_OUTPUT) return { output: text, truncated: false };
    return {
        output: `${text.slice(0, MAX_TOOL_OUTPUT)}\n...[truncated — ${text.length} total chars]`,
        truncated: true,
    };
}

export function createDeepEventRecorder(opts: {
    runId: string;
    tenantId: string;
    sink: DeepEventSink;
}): DeepEventRecorder {
    const { runId, tenantId, sink } = opts;
    let seq = 0;
    // Todos are re-emitted on every state write; only a real change is worth a row.
    let lastTodosJson = '';

    async function emit(
        params: Omit<RecordEventParams, 'runId' | 'tenantId'> & { metadata?: Record<string, unknown> },
    ): Promise<void> {
        const row: RecordEventParams = {
            runId,
            tenantId,
            ...params,
            metadata: { ...(params.metadata ?? {}), seq: seq++ },
        };
        try {
            await sink(row);
        } catch (err) {
            console.error(`[DeepEventRecorder] sink failed (${params.eventType}/${params.node}):`, err);
        }
    }

    function withSub(subagentId?: string): Record<string, unknown> {
        return subagentId ? { subagentId } : {};
    }

    return {
        async text(content, subagentId) {
            if (!content?.trim()) return;
            await emit({ eventType: 'execution', node: 'call_model', content, metadata: withSub(subagentId) });
        },

        async reasoning(content, subagentId) {
            if (!content?.trim()) return;
            await emit({
                eventType: 'execution', node: 'call_model', content,
                metadata: { ...withSub(subagentId), reasoning: true },
            });
        },

        async toolCall({ toolCallId, toolName, args, subagentId }) {
            await emit({
                eventType: 'tool_call', node: 'tools', toolName, toolArgs: args,
                metadata: { ...withSub(subagentId), toolCallId },
            });
        },

        async toolResult({ toolCallId, toolName, output, status, subagentId }) {
            const { output: text, truncated } = truncate(output ?? '');
            await emit({
                eventType: 'tool_result', node: 'tools', toolName, toolOutput: text,
                metadata: {
                    ...withSub(subagentId), toolCallId, status,
                    ...(truncated ? { truncated: true } : {}),
                },
            });
        },

        async todos(todos) {
            const json = JSON.stringify(todos);
            if (json === lastTodosJson) return;
            lastTodosJson = json;
            const done = todos.filter(t => t.status === 'completed').length;
            await emit({
                eventType: 'todo', node: 'write_todos',
                content: `${done}/${todos.length} complete`,
                metadata: { todos },
            });
        },

        async subagent(snapshot) {
            await emit({
                eventType: 'subagent', node: 'task',
                content: snapshot.summary ?? snapshot.task,
                metadata: {
                    subagentId: snapshot.id,
                    name: snapshot.role,
                    task: snapshot.task,
                    status: snapshot.status,
                    toolCount: snapshot.toolCount,
                    tokensIn: snapshot.tokensIn,
                    tokensOut: snapshot.tokensOut,
                    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
                },
            });
        },

        async memory(op, summary) {
            await emit({
                eventType: op === 'recall' ? 'memory_recall' : 'memory_save',
                node: 'deep_memory',
                content: summary,
            });
        },

        async approvalGate(actions) {
            const names = actions.map(a => a.toolName).join(', ');
            await emit({
                eventType: 'planning', node: 'deep_approval_gate',
                content: `Awaiting approval for: ${names}`,
                metadata: { pendingActions: actions },
            });
        },

        async final(content, metadata) {
            await emit({
                eventType: 'final', node: '__end__', content: content.slice(0, 5000),
                metadata,
            });
        },

        async raw(params) {
            await emit(params);
        },
    };
}

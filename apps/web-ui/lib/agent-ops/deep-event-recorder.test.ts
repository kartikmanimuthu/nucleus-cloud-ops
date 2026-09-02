import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDeepEventRecorder, MAX_TOOL_OUTPUT } from './deep-event-recorder';
import type { RecordEventParams } from './record-and-emit';

function harness() {
    const sink = vi.fn<(params: RecordEventParams) => Promise<void>>().mockResolvedValue(undefined);
    const rec = createDeepEventRecorder({ runId: 'run-1', tenantId: 'tenant-1', sink });
    return { sink, rec, rows: () => sink.mock.calls.map(c => c[0]) };
}

describe('createDeepEventRecorder', () => {
    beforeEach(() => vi.clearAllMocks());

    it('stamps runId and tenantId on every row', async () => {
        const { rec, rows } = harness();
        await rec.text('hello');
        expect(rows()[0].runId).toBe('run-1');
        expect(rows()[0].tenantId).toBe('tenant-1');
    });

    it('assigns a strictly increasing seq across all event kinds', async () => {
        const { rec, rows } = harness();
        await rec.text('a');
        await rec.toolCall({ toolCallId: 'c1', toolName: 'execute_command', args: { command: 'ls' } });
        await rec.todos([{ content: 'step one', status: 'pending' }]);
        await rec.memory('recall', 'found 2 memories');
        const seqs = rows().map(r => r.metadata?.seq as number);
        expect(seqs).toEqual([0, 1, 2, 3]);
    });

    it('maps text to an execution event on call_model', async () => {
        const { rec, rows } = harness();
        await rec.text('thinking out loud');
        expect(rows()[0]).toMatchObject({
            eventType: 'execution', node: 'call_model', content: 'thinking out loud',
        });
    });

    it('flags reasoning separately from plain text', async () => {
        const { rec, rows } = harness();
        await rec.reasoning('internal deliberation');
        expect(rows()[0].eventType).toBe('execution');
        expect(rows()[0].metadata?.reasoning).toBe(true);
    });

    it('skips empty text without calling the sink', async () => {
        const { rec, sink } = harness();
        await rec.text('');
        await rec.text('   ');
        await rec.reasoning('');
        expect(sink).not.toHaveBeenCalled();
    });

    it('records a tool call with its args and id', async () => {
        const { rec, rows } = harness();
        await rec.toolCall({ toolCallId: 'c1', toolName: 'execute_command', args: { command: 'aws s3 ls' } });
        expect(rows()[0]).toMatchObject({
            eventType: 'tool_call', node: 'tools', toolName: 'execute_command',
            toolArgs: { command: 'aws s3 ls' },
        });
        expect(rows()[0].metadata?.toolCallId).toBe('c1');
    });

    it('truncates tool output at MAX_TOOL_OUTPUT and says so', async () => {
        const { rec, rows } = harness();
        const huge = 'x'.repeat(MAX_TOOL_OUTPUT + 500);
        await rec.toolResult({ toolCallId: 'c1', toolName: 'execute_command', output: huge, status: 'finished' });
        const out = rows()[0].toolOutput as string;
        expect(out.length).toBeLessThan(huge.length);
        expect(out).toContain('truncated');
        expect(rows()[0].metadata?.truncated).toBe(true);
    });

    it('leaves short tool output untouched', async () => {
        const { rec, rows } = harness();
        await rec.toolResult({ toolCallId: 'c1', toolName: 'ls', output: 'a\nb', status: 'finished' });
        expect(rows()[0].toolOutput).toBe('a\nb');
        expect(rows()[0].metadata?.truncated).toBeUndefined();
    });

    it('marks an errored tool result', async () => {
        const { rec, rows } = harness();
        await rec.toolResult({ toolCallId: 'c1', toolName: 'ls', output: 'boom', status: 'error' });
        expect(rows()[0].metadata?.status).toBe('error');
    });

    it('tags sub-agent work with subagentId so the timeline can group it', async () => {
        const { rec, rows } = harness();
        await rec.toolCall({ toolCallId: 'c1', toolName: 'execute_command', args: {}, subagentId: 'sub-7' });
        expect(rows()[0].metadata?.subagentId).toBe('sub-7');
    });

    it('records todos as a single todo event carrying the whole list', async () => {
        const { rec, rows } = harness();
        await rec.todos([
            { content: 'one', status: 'completed' },
            { content: 'two', status: 'in_progress' },
        ]);
        expect(rows()[0]).toMatchObject({ eventType: 'todo', node: 'write_todos' });
        expect(rows()[0].metadata?.todos).toHaveLength(2);
    });

    it('skips a todo write that is identical to the previous one', async () => {
        const { rec, sink } = harness();
        const todos = [{ content: 'one', status: 'pending' as const }];
        await rec.todos(todos);
        await rec.todos([{ content: 'one', status: 'pending' }]);
        expect(sink).toHaveBeenCalledTimes(1);
    });

    it('records a sub-agent lifecycle event', async () => {
        const { rec, rows } = harness();
        await rec.subagent({
            id: 'sub-1', role: 'aws-ops', task: 'list buckets', status: 'done',
            toolCount: 3, tokensIn: 100, tokensOut: 50, summary: 'found 4 buckets',
        });
        expect(rows()[0]).toMatchObject({ eventType: 'subagent', node: 'task' });
        expect(rows()[0].metadata).toMatchObject({
            subagentId: 'sub-1', name: 'aws-ops', status: 'done', toolCount: 3,
        });
    });

    it('maps memory ops onto the plan graph event types', async () => {
        const { rec, rows } = harness();
        await rec.memory('recall', 'two prior findings');
        await rec.memory('save', '{"saved":1}');
        expect(rows()[0]).toMatchObject({ eventType: 'memory_recall', node: 'deep_memory' });
        expect(rows()[1]).toMatchObject({ eventType: 'memory_save', node: 'deep_memory' });
    });

    it('records the approval gate with its pending actions', async () => {
        const { rec, rows } = harness();
        await rec.approvalGate([
            { toolCallId: 'ck:i1#0', toolName: 'execute_command', args: { command: 'rm -rf /' }, interruptId: 'i1', index: 0 },
        ]);
        expect(rows()[0]).toMatchObject({ eventType: 'planning', node: 'deep_approval_gate' });
        expect(rows()[0].content).toContain('execute_command');
        expect(rows()[0].metadata?.pendingActions).toHaveLength(1);
    });

    it('records the final summary', async () => {
        const { rec, rows } = harness();
        await rec.final('all done');
        expect(rows()[0]).toMatchObject({ eventType: 'final', node: '__end__', content: 'all done' });
    });

    it('never lets a sink failure escape', async () => {
        const sink = vi.fn().mockRejectedValue(new Error('db down'));
        const rec = createDeepEventRecorder({ runId: 'r', tenantId: 't', sink });
        await expect(rec.text('hi')).resolves.toBeUndefined();
    });

    // ── Amendment: raw() and final(content, metadata) ──────────────────

    it('raw() stamps a seq drawn from the same counter as the typed methods', async () => {
        const { rec, rows } = harness();
        await rec.text('a');
        await rec.raw({ eventType: 'error', node: 'run_start', content: 'run started' });
        const seqs = rows().map(r => r.metadata?.seq as number);
        expect(seqs).toEqual([0, 1]);
        expect(rows()[1]).toMatchObject({ eventType: 'error', node: 'run_start', content: 'run started' });
    });

    it('raw() swallows a sink failure', async () => {
        const sink = vi.fn().mockRejectedValue(new Error('db down'));
        const rec = createDeepEventRecorder({ runId: 'r', tenantId: 't', sink });
        await expect(rec.raw({ eventType: 'error', node: 'run_error', content: 'boom' })).resolves.toBeUndefined();
    });

    it('final() merges caller metadata alongside seq', async () => {
        const { rec, rows } = harness();
        await rec.final('all done', { durationMs: 1234, tokensIn: 10, tokensOut: 20 });
        expect(rows()[0]).toMatchObject({ eventType: 'final', node: '__end__', content: 'all done' });
        expect(rows()[0].metadata).toMatchObject({ durationMs: 1234, tokensIn: 10, tokensOut: 20 });
        expect(typeof rows()[0].metadata?.seq).toBe('number');
    });
});

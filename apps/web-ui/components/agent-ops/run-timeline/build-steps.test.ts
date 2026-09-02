import { describe, it, expect } from 'vitest';
import { buildSteps, type TimelineStep } from './build-steps';
import type { AgentOpsEvent } from '@/lib/agent-ops/types';

let seq = 0;
function ev(partial: Partial<AgentOpsEvent>): AgentOpsEvent {
    seq += 1;
    return {
        PK: 'RUN#r1', SK: `EVENT#${seq}#0`, runId: 'r1',
        eventType: 'execution', node: 'generate',
        createdAt: new Date(1700000000000 + seq * 1000).toISOString(),
        ttl: 0, ...partial,
    } as AgentOpsEvent;
}

describe('buildSteps', () => {
    it('pairs a tool_call with its matching tool_result', () => {
        const steps = buildSteps([
            ev({ eventType: 'tool_call', toolName: 'execute_command' }),
            ev({ eventType: 'tool_result', toolName: 'execute_command', toolOutput: 'ok output' }),
        ], 'completed');
        expect(steps).toHaveLength(1);
        const t = steps[0] as Extract<TimelineStep, { kind: 'tool' }>;
        expect(t.kind).toBe('tool');
        expect(t.status).toBe('ok');
        expect(t.durationMs).toBe(1000);
    });

    it('flags an error result', () => {
        const steps = buildSteps([
            ev({ eventType: 'tool_call', toolName: 'execute_command' }),
            ev({ eventType: 'tool_result', toolName: 'execute_command', toolOutput: 'Command failed: aws sts ...' }),
        ], 'completed');
        expect((steps[0] as Extract<TimelineStep, { kind: 'tool' }>).status).toBe('error');
    });

    it('marks an unpaired call running while the run is active, unknown when settled', () => {
        const events = [ev({ eventType: 'tool_call', toolName: 'glob' })];
        expect((buildSteps(events, 'in_progress')[0] as Extract<TimelineStep, { kind: 'tool' }>).status).toBe('running');
        expect((buildSteps(events, 'failed')[0] as Extract<TimelineStep, { kind: 'tool' }>).status).toBe('unknown');
    });

    it('promotes thinking execution events to thinking bubbles', () => {
        const steps = buildSteps([
            ev({ eventType: 'execution', metadata: { contentType: 'thinking' }, content: 'Now I will…' }),
        ], 'completed');
        expect(steps[0].kind).toBe('thinking');
    });

    it('maps memory and evaluation events to dedicated steps', () => {
        const steps = buildSteps([
            ev({ eventType: 'memory_recall', node: 'memory_recall' }),
            ev({ eventType: 'evaluation', node: 'evaluator' }),
            ev({ eventType: 'memory_save', node: 'memory_save' }),
        ], 'completed');
        expect(steps.map(s => s.kind)).toEqual(['memory', 'evaluation', 'memory']);
        expect((steps[0] as Extract<TimelineStep, { kind: 'memory' }>).phase).toBe('recall');
        expect((steps[2] as Extract<TimelineStep, { kind: 'memory' }>).phase).toBe('save');
    });

    it('treats legacy evaluator planning events as evaluation (old runs)', () => {
        // Old runs recorded the evaluator's structured decision on the legacy
        // 'planning' eventType, carrying { mode, skillId } metadata.
        const steps = buildSteps([
            ev({ eventType: 'planning', node: 'evaluator', metadata: { mode: 'fast', skillId: null } }),
        ], 'completed');
        expect(steps[0].kind).toBe('evaluation');
    });

    it('does not treat the evaluator node raw LLM chatter as a second evaluation step', () => {
        // The evaluator node's own LLM call is recorded as a 'planning' event too,
        // but with generation metadata (inputTokens/outputTokens/contentType) —
        // not the structured { mode, ... } shape — so it must fold into the
        // normal planning step, not a duplicate pill-less evaluation.
        const steps = buildSteps([
            ev({
                eventType: 'planning',
                node: 'evaluator',
                metadata: { inputTokens: 5, outputTokens: 2, contentType: 'response' },
            }),
        ], 'completed');
        expect(steps[0].kind).toBe('planning');
    });

    it('folds ≥3 contiguous work steps into a group, keeps structural steps outside', () => {
        const steps = buildSteps([
            ev({ eventType: 'planning', node: '__start__' }),
            ev({ eventType: 'tool_call', toolName: 'a' }),
            ev({ eventType: 'tool_result', toolName: 'a', toolOutput: 'x' }),
            ev({ eventType: 'execution', metadata: { contentType: 'thinking' }, content: 't' }),
            ev({ eventType: 'tool_call', toolName: 'b' }),
            ev({ eventType: 'tool_result', toolName: 'b', toolOutput: 'y' }),
            ev({ eventType: 'reflection', node: 'reflect', content: 'looks done' }),
        ], 'completed');
        expect(steps.map(s => s.kind)).toEqual(['planning', 'group', 'reflection']);
        const g = steps[1] as Extract<TimelineStep, { kind: 'group' }>;
        expect(g.steps).toHaveLength(3);
        expect(g.running).toBe(false);
    });

    it('does not fold short work runs (< 3 steps)', () => {
        const steps = buildSteps([
            ev({ eventType: 'tool_call', toolName: 'a' }),
            ev({ eventType: 'tool_result', toolName: 'a', toolOutput: 'x' }),
        ], 'completed');
        expect(steps[0].kind).toBe('tool');
    });

    it('group containing the running step reports running: true', () => {
        const steps = buildSteps([
            ev({ eventType: 'tool_call', toolName: 'a' }),
            ev({ eventType: 'tool_result', toolName: 'a', toolOutput: 'x' }),
            ev({ eventType: 'execution', metadata: { contentType: 'thinking' }, content: 't' }),
            ev({ eventType: 'tool_call', toolName: 'b' }),
        ], 'in_progress');
        const g = steps[0] as Extract<TimelineStep, { kind: 'group' }>;
        expect(g.kind).toBe('group');
        expect(g.running).toBe(true);
    });
});

describe('buildSteps — deep mode', () => {
    const evDeep = (over: Partial<AgentOpsEvent> & { eventType: string }): AgentOpsEvent => ({
        PK: 'RUN#r1', SK: '', runId: 'r1', node: 'n', createdAt: '2026-08-24T10:00:00.000Z', ttl: 0,
        ...over,
    } as AgentOpsEvent);

    it('sorts by metadata.seq, not insertion order', () => {
        const steps = buildSteps([
            evDeep({ eventType: 'execution', content: 'second', createdAt: '2026-08-24T10:00:00.000Z', metadata: { seq: 1 } }),
            evDeep({ eventType: 'execution', content: 'first', createdAt: '2026-08-24T10:00:00.000Z', metadata: { seq: 0 } }),
        ], 'completed');
        const contents = steps.flatMap(s => (s.kind === 'group' ? s.steps : [s]))
            .map(s => (s.kind === 'thinking' ? s.event.content : undefined))
            .filter(Boolean);
        expect(contents).toEqual(['first', 'second']);
    });

    it('orders a mixed population (some rows with seq, some without) deterministically on a shared createdAt', () => {
        const steps = buildSteps([
            evDeep({ eventType: 'execution', content: 'A', createdAt: '2026-08-24T10:00:00.000Z', metadata: { seq: 5 } }),
            evDeep({ eventType: 'execution', content: 'C', createdAt: '2026-08-24T10:00:00.000Z' }), // no seq — e.g. a synthetic decision/approve row
            evDeep({ eventType: 'execution', content: 'B', createdAt: '2026-08-24T10:00:00.000Z', metadata: { seq: 1 } }),
        ], 'completed');
        const contents = steps.flatMap(s => (s.kind === 'group' ? s.steps : [s]))
            .map(s => (s.kind === 'thinking' ? s.event.content : undefined))
            .filter(Boolean);
        // The old "seq wins only when both sides have it, else compare createdAt"
        // comparator was intransitive here (A beats B on seq; both tie C on
        // createdAt), so the result depended on array input order rather than
        // being well-defined. The fixed createdAt-then-(seq ?? -1) comparator
        // gives one deterministic answer: the seq-less row sorts first, then
        // ascending by seq.
        expect(contents).toEqual(['C', 'B', 'A']);
    });

    it("keeps a resumed run's second leg after the first leg instead of interleaving by seq", () => {
        const steps = buildSteps([
            evDeep({ eventType: 'execution', content: 'leg1-a', createdAt: '2026-08-24T10:00:01.000Z', metadata: { seq: 0 } }),
            evDeep({ eventType: 'execution', content: 'leg1-b', createdAt: '2026-08-24T10:00:01.000Z', metadata: { seq: 1 } }),
            evDeep({ eventType: 'execution', content: 'route-row', createdAt: '2026-08-24T10:00:02.000Z' }),
            evDeep({ eventType: 'execution', content: 'leg2-a', createdAt: '2026-08-24T10:00:03.000Z', metadata: { seq: 0 } }),
            evDeep({ eventType: 'execution', content: 'leg2-b', createdAt: '2026-08-24T10:00:03.000Z', metadata: { seq: 1 } }),
        ], 'completed');
        const contents = steps.flatMap(s => (s.kind === 'group' ? s.steps : [s]))
            .map(s => (s.kind === 'thinking' ? s.event.content : undefined))
            .filter(Boolean);
        // Each DeepEventRecorder instance restarts its seq counter at 0 (execute
        // and every resume each build a fresh recorder), so leg-2's seq=0/1 must
        // NOT sort ahead of leg-1's seq=0/1 just because seq is smaller/equal —
        // only createdAt, which differs across legs, may separate them.
        expect(contents).toEqual(['leg1-a', 'leg1-b', 'route-row', 'leg2-a', 'leg2-b']);
    });

    it('keeps only the latest todo state', () => {
        const steps = buildSteps([
            evDeep({ eventType: 'todo', metadata: { seq: 0, todos: [{ content: 'a', status: 'pending' }] } }),
            evDeep({ eventType: 'todo', metadata: { seq: 1, todos: [{ content: 'a', status: 'completed' }] } }),
        ], 'completed');
        const todos = steps.filter(s => s.kind === 'todo');
        expect(todos).toHaveLength(1);
        expect((todos[0] as { todos: Array<{ status: string }> }).todos[0].status).toBe('completed');
    });

    it('groups events tagged with the same subagentId', () => {
        const steps = buildSteps([
            evDeep({ eventType: 'subagent', metadata: { seq: 0, subagentId: 's1', name: 'aws-ops', status: 'running', task: 'list' } }),
            evDeep({ eventType: 'tool_call', toolName: 'execute_command', metadata: { seq: 1, subagentId: 's1' } }),
            evDeep({ eventType: 'tool_result', toolName: 'execute_command', toolOutput: 'ok', metadata: { seq: 2, subagentId: 's1' } }),
            evDeep({ eventType: 'subagent', metadata: { seq: 3, subagentId: 's1', name: 'aws-ops', status: 'done', task: 'list', summary: '4 buckets' } }),
        ], 'completed');
        const subs = steps.filter(s => s.kind === 'subagent');
        expect(subs).toHaveLength(1);
        const sub = subs[0] as { name: string; status: string; steps: unknown[] };
        expect(sub.name).toBe('aws-ops');
        expect(sub.status).toBe('done');
        expect(sub.steps.length).toBeGreaterThan(0);
    });

    it('keeps parent-level tool calls out of sub-agent groups', () => {
        const steps = buildSteps([
            evDeep({ eventType: 'tool_call', toolName: 'list_aws_accounts', metadata: { seq: 0 } }),
            evDeep({ eventType: 'tool_result', toolName: 'list_aws_accounts', toolOutput: 'ok', metadata: { seq: 1 } }),
            evDeep({ eventType: 'subagent', metadata: { seq: 2, subagentId: 's1', name: 'research', status: 'done', task: 'look up' } }),
        ], 'completed');
        expect(steps.some(s => s.kind === 'subagent')).toBe(true);
        const flat = steps.flatMap(s => (s.kind === 'group' ? s.steps : [s]));
        expect(flat.some(s => s.kind === 'tool' && s.toolName === 'list_aws_accounts')).toBe(true);
    });

    // Strengthened vs. the brief: both rows share one createdAt (the exact
    // "concurrent producers" tie the ordering doc talks about) and no seq, so
    // this only passes if the sort preserves arrival order on a tie instead of
    // inventing a tiebreaker. With the brief's original 1-second-apart
    // timestamps, createdAt ordering alone would produce the right answer even
    // if seq-less ties were resolved arbitrarily — this version actually
    // exercises the "keep arrival order" contract.
    it('pairs tool_result to its call by metadata.toolCallId even when two same-named calls settle out of order', () => {
        // Deep drains run.toolCalls in parallel watchers, so two concurrent
        // execute_command calls can have their results arrive in either order.
        // A name-only matcher pairs FIFO and would cross-pair these: call-1's
        // result (from call-2's args) would land on call-1's card and vice versa.
        const steps = buildSteps([
            evDeep({
                eventType: 'tool_call', toolName: 'execute_command', toolArgs: { cmd: 'first' },
                createdAt: '2026-08-24T10:00:00.000Z', metadata: { seq: 0, toolCallId: 'call-1' },
            }),
            evDeep({
                eventType: 'tool_call', toolName: 'execute_command', toolArgs: { cmd: 'second' },
                createdAt: '2026-08-24T10:00:01.000Z', metadata: { seq: 1, toolCallId: 'call-2' },
            }),
            // call-2 settles FIRST, out of call order.
            evDeep({
                eventType: 'tool_result', toolName: 'execute_command', toolOutput: 'second-output',
                createdAt: '2026-08-24T10:00:02.000Z', metadata: { seq: 2, toolCallId: 'call-2' },
            }),
            evDeep({
                eventType: 'tool_result', toolName: 'execute_command', toolOutput: 'first-output',
                createdAt: '2026-08-24T10:00:03.000Z', metadata: { seq: 3, toolCallId: 'call-1' },
            }),
        ], 'completed');

        const tools = steps.flatMap(s => (s.kind === 'group' ? s.steps : [s]))
            .filter((s): s is Extract<TimelineStep, { kind: 'tool' }> => s.kind === 'tool');
        expect(tools).toHaveLength(2);

        const byCallId = new Map(
            tools.map(t => [(t.call?.metadata as { toolCallId?: string } | undefined)?.toolCallId, t]),
        );
        expect(byCallId.get('call-1')?.call?.toolArgs).toEqual({ cmd: 'first' });
        expect(byCallId.get('call-1')?.result?.toolOutput).toBe('first-output');
        expect(byCallId.get('call-2')?.call?.toolArgs).toEqual({ cmd: 'second' });
        expect(byCallId.get('call-2')?.result?.toolOutput).toBe('second-output');
    });

    it('still handles a plan-mode run with no seq metadata', () => {
        const steps = buildSteps([
            evDeep({ eventType: 'planning', content: 'p', createdAt: '2026-08-24T10:00:00.000Z' }),
            evDeep({ eventType: 'final', content: 'f', createdAt: '2026-08-24T10:00:00.000Z' }),
        ], 'completed');
        expect(steps.map(s => s.kind)).toEqual(['planning', 'final']);
    });
});

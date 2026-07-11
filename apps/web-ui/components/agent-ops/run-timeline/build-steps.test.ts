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

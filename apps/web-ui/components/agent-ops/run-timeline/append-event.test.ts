import { describe, it, expect } from 'vitest';
import { appendEvent } from './use-run-stream';
import type { AgentOpsEvent } from '@/lib/agent-ops/types';

const e = (sk: string) => ({ SK: sk, runId: 'r1', eventType: 'planning', node: 'x', createdAt: 'now', PK: 'RUN#r1', ttl: 0 }) as AgentOpsEvent;

describe('appendEvent', () => {
    it('appends a new event', () => {
        const old = { run: { runId: 'r1' }, events: [e('EVENT#1#0')] } as never;
        const next = appendEvent(old, e('EVENT#2#0'));
        expect(next!.events).toHaveLength(2);
    });
    it('dedups by SK', () => {
        const old = { run: { runId: 'r1' }, events: [e('EVENT#1#0')] } as never;
        const next = appendEvent(old, e('EVENT#1#0'));
        expect(next!.events).toHaveLength(1);
    });
    it('returns undefined when cache is empty (no clobber before initial fetch)', () => {
        expect(appendEvent(undefined, e('EVENT#1#0'))).toBeUndefined();
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { recordEvent: vi.fn().mockResolvedValue(undefined) },
}));

import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { isStepBoundary, recordAndEmit } from './record-and-emit';

const params = { runId: 'run-1', tenantId: 'tenant-1', eventType: 'tool_call' as const, node: 'agent', toolName: 'execute_command' };

describe('isStepBoundary', () => {
    it('accepts the four narratable event types', () => {
        expect(isStepBoundary('planning')).toBe(true);
        expect(isStepBoundary('tool_call')).toBe(true);
        expect(isStepBoundary('tool_result')).toBe(true);
        expect(isStepBoundary('reflection')).toBe(true);
    });

    it('rejects non-boundary event types', () => {
        expect(isStepBoundary('memory_save')).toBe(false);
        expect(isStepBoundary('evaluation')).toBe(false);
        expect(isStepBoundary('execution')).toBe(false);
    });
});

describe('recordAndEmit', () => {
    beforeEach(() => vi.clearAllMocks());

    it('always records, and emits run:event for a step boundary', async () => {
        const emit = vi.fn();
        await recordAndEmit({ emit } as any, params);

        expect(agentOpsService.recordEvent).toHaveBeenCalledWith(params);
        expect(emit).toHaveBeenCalledTimes(1);
        const emitted = emit.mock.calls[0][0];
        expect(emitted.type).toBe('run:event');
        expect(emitted.runId).toBe('run-1');
        expect(emitted.tenantId).toBe('tenant-1');
        expect(emitted.data.event.eventType).toBe('tool_call');
        expect(emitted.data.event.toolName).toBe('execute_command');
    });

    it('records but does not emit for a non-boundary event', async () => {
        const emit = vi.fn();
        await recordAndEmit({ emit } as any, { ...params, eventType: 'memory_save' });

        expect(agentOpsService.recordEvent).toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
    });

    it('records normally when no event bus is supplied', async () => {
        await recordAndEmit(undefined, params);
        expect(agentOpsService.recordEvent).toHaveBeenCalledWith(params);
    });

    it('never lets an emit failure escape', async () => {
        const emit = vi.fn(() => { throw new Error('bus exploded'); });
        await expect(recordAndEmit({ emit } as any, params)).resolves.toBeUndefined();
        expect(agentOpsService.recordEvent).toHaveBeenCalled();
    });
});

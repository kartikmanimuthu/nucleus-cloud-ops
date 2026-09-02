import { describe, it, expect } from 'vitest';
import { extractThreadRunState } from './run-state';

describe('extractThreadRunState', () => {
    it('returns null plan and null pendingInterrupt for empty channel values', () => {
        const result = extractThreadRunState(undefined, 'thread-1');
        expect(result).toEqual({ plan: null, pendingInterrupt: null });
    });

    it('returns the plan when it is a non-empty array', () => {
        const result = extractThreadRunState({ plan: [{ step: 'Check EC2', status: 'pending' }] } as any, 'thread-1');
        expect(result.plan).toEqual([{ step: 'Check EC2', status: 'pending' }]);
    });

    it('treats an empty plan array as no plan', () => {
        const result = extractThreadRunState({ plan: [] } as any, 'thread-1');
        expect(result.plan).toBeNull();
    });

    it('never surfaces a pendingInterrupt when guardVerdicts is empty (deep-agent/legacy threads)', () => {
        const result = extractThreadRunState({ guardVerdicts: {} } as any, 'thread-1');
        expect(result.pendingInterrupt).toBeNull();
    });

    it('builds a pendingInterrupt from unresolved tool calls when guardVerdicts is populated', () => {
        const messages = [
            {
                _getType: () => 'ai',
                tool_calls: [{ id: 'call-1', name: 'stop_instance', args: { instanceId: 'i-1' } }],
            },
        ];
        const guardVerdicts = { 'call-1': { decision: 'review', reason: 'stops a running instance' } };
        const result = extractThreadRunState({ messages, guardVerdicts } as any, 'thread-1');

        expect(result.pendingInterrupt).not.toBeNull();
        expect(result.pendingInterrupt!.parts[0].type).toBe('data-approval');
    });

    it('returns a null pendingInterrupt when guardVerdicts is populated but nothing is actually pending', () => {
        const messages = [
            { _getType: () => 'ai', tool_calls: [] },
        ];
        const guardVerdicts = { 'call-1': { decision: 'review', reason: 'stale verdict' } };
        const result = extractThreadRunState({ messages, guardVerdicts } as any, 'thread-1');
        expect(result.pendingInterrupt).toBeNull();
    });
});

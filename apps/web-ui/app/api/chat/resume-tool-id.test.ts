import { describe, it, expect } from 'vitest';
import { resolveResumedToolCallId, type ResumedPendingCall } from './resume-tool-id';

describe('resolveResumedToolCallId', () => {
    it('falls back to runId when there are no candidates', () => {
        const id = resolveResumedToolCallId([], new Set(), 'read_file', {}, 'run-1');
        expect(id).toBe('run-1');
    });

    it('uses the single matching candidate', () => {
        const pendingCalls: ResumedPendingCall[] = [{ id: 'call-1', name: 'read_file', args: {} }];
        const consumed = new Set<string>();
        const id = resolveResumedToolCallId(pendingCalls, consumed, 'read_file', {}, 'run-1');
        expect(id).toBe('call-1');
        expect(consumed.has('call-1')).toBe(true);
    });

    it('skips already-consumed candidates', () => {
        const pendingCalls: ResumedPendingCall[] = [
            { id: 'call-1', name: 'read_file', args: {} },
            { id: 'call-2', name: 'read_file', args: {} },
        ];
        const consumed = new Set<string>(['call-1']);
        const id = resolveResumedToolCallId(pendingCalls, consumed, 'read_file', {}, 'run-1');
        expect(id).toBe('call-2');
    });

    it('prefers the candidate whose args JSON-match the live input among several', () => {
        const pendingCalls: ResumedPendingCall[] = [
            { id: 'call-1', name: 'read_file', args: { path: 'a.ts' } },
            { id: 'call-2', name: 'read_file', args: { path: 'b.ts' } },
        ];
        const consumed = new Set<string>();
        const id = resolveResumedToolCallId(pendingCalls, consumed, 'read_file', { path: 'b.ts' }, 'run-1');
        expect(id).toBe('call-2');
        expect(consumed.has('call-2')).toBe(true);
    });

    it('falls back to the first remaining candidate when no args match', () => {
        const pendingCalls: ResumedPendingCall[] = [
            { id: 'call-1', name: 'read_file', args: { path: 'a.ts' } },
            { id: 'call-2', name: 'read_file', args: { path: 'b.ts' } },
        ];
        const consumed = new Set<string>();
        const id = resolveResumedToolCallId(pendingCalls, consumed, 'read_file', { path: 'c.ts' }, 'run-1');
        expect(id).toBe('call-1');
    });

    it('falls back to the first remaining candidate when the input cannot be JSON-stringified', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const pendingCalls: ResumedPendingCall[] = [
            { id: 'call-1', name: 'read_file', args: { path: 'a.ts' } },
            { id: 'call-2', name: 'read_file', args: { path: 'b.ts' } },
        ];
        const consumed = new Set<string>();
        const id = resolveResumedToolCallId(pendingCalls, consumed, 'read_file', circular, 'run-1');
        expect(id).toBe('call-1');
    });

    it('falls back to the first remaining candidate when a candidate has unstringifiable args', () => {
        const circularArgs: Record<string, unknown> = {};
        circularArgs.self = circularArgs;
        const pendingCalls: ResumedPendingCall[] = [
            { id: 'call-1', name: 'read_file', args: circularArgs },
            { id: 'call-2', name: 'read_file', args: { path: 'b.ts' } },
        ];
        const consumed = new Set<string>();
        const id = resolveResumedToolCallId(pendingCalls, consumed, 'read_file', { path: 'b.ts' }, 'run-1');
        expect(id).toBe('call-2');
    });
});

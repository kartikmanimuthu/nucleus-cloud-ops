import { describe, it, expect } from 'vitest';
import { resolveResumedToolCallId, type ResumedPendingCall } from '@/app/api/chat/resume-tool-id';

const calls = (...c: ResumedPendingCall[]) => c;

describe('resolveResumedToolCallId', () => {
    it('unique name match → returns the original id and consumes it', () => {
        const pending = calls(
            { id: 'tooluse_A', name: 'execute_command', args: { command: 'aws s3 ls' } },
            { id: 'tooluse_B', name: 'read_file', args: { path: '/tmp/x' } },
        );
        const consumed = new Set<string>();
        expect(resolveResumedToolCallId(pending, consumed, 'execute_command', { command: 'aws s3 ls' }, 'run-1'))
            .toBe('tooluse_A');
        expect(consumed.has('tooluse_A')).toBe(true);
        expect(consumed.has('tooluse_B')).toBe(false);
    });

    it('duplicate names → prefers the candidate whose args match the live input', () => {
        const pending = calls(
            { id: 'tooluse_A', name: 'execute_command', args: { command: 'first' } },
            { id: 'tooluse_B', name: 'execute_command', args: { command: 'second' } },
        );
        const consumed = new Set<string>();
        expect(resolveResumedToolCallId(pending, consumed, 'execute_command', { command: 'second' }, 'run-1'))
            .toBe('tooluse_B');
        expect(consumed.has('tooluse_B')).toBe(true);
    });

    it('two IDENTICAL calls map to distinct ids via consumption', () => {
        const pending = calls(
            { id: 'tooluse_A', name: 'execute_command', args: { command: 'same' } },
            { id: 'tooluse_B', name: 'execute_command', args: { command: 'same' } },
        );
        const consumed = new Set<string>();
        const first = resolveResumedToolCallId(pending, consumed, 'execute_command', { command: 'same' }, 'run-1');
        const second = resolveResumedToolCallId(pending, consumed, 'execute_command', { command: 'same' }, 'run-2');
        expect(first).toBe('tooluse_A');
        expect(second).toBe('tooluse_B');
    });

    it('duplicate names with no args match → falls back to the first unconsumed (calls run in order)', () => {
        const pending = calls(
            { id: 'tooluse_A', name: 'execute_command', args: { command: 'first' } },
            { id: 'tooluse_B', name: 'execute_command', args: { command: 'second' } },
        );
        const consumed = new Set<string>();
        expect(resolveResumedToolCallId(pending, consumed, 'execute_command', { command: 'other' }, 'run-1'))
            .toBe('tooluse_A');
    });

    it('no matching pending call → falls back to runId without consuming anything', () => {
        const pending = calls({ id: 'tooluse_A', name: 'read_file', args: {} });
        const consumed = new Set<string>();
        expect(resolveResumedToolCallId(pending, consumed, 'execute_command', {}, 'run-9')).toBe('run-9');
        expect(consumed.size).toBe(0);
    });

    it('all candidates consumed → falls back to runId', () => {
        const pending = calls({ id: 'tooluse_A', name: 'execute_command', args: {} });
        const consumed = new Set<string>(['tooluse_A']);
        expect(resolveResumedToolCallId(pending, consumed, 'execute_command', {}, 'run-9')).toBe('run-9');
    });
});

import { describe, it, expect } from 'vitest';
import { extractServerErrorMessage } from './use-chat-session-helpers';

describe('extractServerErrorMessage', () => {
    it('returns null when there is no error', () => {
        expect(extractServerErrorMessage(undefined)).toBeNull();
        expect(extractServerErrorMessage(null)).toBeNull();
    });

    it('returns null for a blank message', () => {
        expect(extractServerErrorMessage(new Error('   '))).toBeNull();
        expect(extractServerErrorMessage('')).toBeNull();
    });

    it('returns a friendly recovery message for a stream-protocol violation', () => {
        const result = extractServerErrorMessage(new Error('text-delta" chunk with no matching text-start'));
        expect(result).toContain("run's progress is saved");
    });

    it('matches the stream-protocol pattern case-insensitively and for each variant', () => {
        expect(extractServerErrorMessage(new Error('Missing Text Part detected'))).toContain('protocol error');
        expect(extractServerErrorMessage(new Error('invalid chunk order in stream'))).toContain('protocol error');
        expect(extractServerErrorMessage(new Error('text-start" chunk arrived twice'))).toContain('protocol error');
        expect(extractServerErrorMessage(new Error('text-end" chunk missing'))).toContain('protocol error');
    });

    it('extracts the server-provided error string from an embedded JSON body', () => {
        const err = new Error('Request failed with status 400: {"success":false,"error":"Tenant not found"}');
        expect(extractServerErrorMessage(err)).toBe('Tenant not found');
    });

    it('falls back to the raw trimmed message when the JSON has no usable error field', () => {
        const err = new Error('  {"success":false} some text  ');
        expect(extractServerErrorMessage(err)).toBe('{"success":false} some text');
    });

    it('falls back to the raw trimmed message when the embedded braces are not valid JSON', () => {
        const err = new Error('boom {not valid json}');
        expect(extractServerErrorMessage(err)).toBe('boom {not valid json}');
    });

    it('accepts a plain string error', () => {
        expect(extractServerErrorMessage('plain string error')).toBe('plain string error');
    });

    it('treats a non-Error, non-string value as an empty message (null)', () => {
        expect(extractServerErrorMessage({ some: 'object' })).toBeNull();
        expect(extractServerErrorMessage(42)).toBeNull();
    });
});

/**
 * Unit tests for buildClientErrorText — turns a thrown backend error into a
 * descriptive message the chat UI can render (instead of a generic "network error").
 */

import { describe, it, expect } from 'vitest';
import { buildClientErrorText } from '../../lib/agent/stream-error';

describe('buildClientErrorText', () => {
    it('includes the error name and message for a named error', () => {
        const err = new Error('The toolConfig field must be defined when using toolUse and toolResult content blocks.');
        err.name = 'ValidationException';

        const text = buildClientErrorText(err);

        expect(text).toContain('ValidationException');
        expect(text).toContain('toolConfig field must be defined');
        // Must NOT collapse to a generic message.
        expect(text).not.toBe('network error');
    });

    it('surfaces the underlying cause of a wrapped error', () => {
        const cause = new Error('Expected toolResult blocks at messages.0.content');
        cause.name = 'ValidationException';
        const wrapper = new Error('failed to pipe response', { cause });

        const text = buildClientErrorText(wrapper);

        expect(text).toContain('failed to pipe response');
        expect(text).toContain('Cause:');
        expect(text).toContain('Expected toolResult blocks');
    });

    it('does not duplicate the cause when it already appears in the message', () => {
        const cause = new Error('boom');
        const wrapper = new Error('wrapper boom', { cause });
        // head does not contain "boom" exactly as "Error: boom", so cause is appended once
        const text = buildClientErrorText(wrapper);
        expect(text.match(/Cause:/g)?.length ?? 0).toBeLessThanOrEqual(1);
    });

    it('drops the redundant "Error:" prefix for a plain Error', () => {
        const text = buildClientErrorText(new Error('something broke'));
        expect(text).toBe('something broke');
    });

    it('passes a string error through unchanged', () => {
        expect(buildClientErrorText('raw failure')).toBe('raw failure');
    });

    it('falls back to a readable string for non-error values', () => {
        expect(buildClientErrorText({ code: 500 })).toContain('500');
        expect(buildClientErrorText(null)).toBe('null');
    });

    it('falls back to "Unknown error" when the value cannot be JSON.stringified (circular reference)', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(buildClientErrorText(circular)).toBe('Unknown error');
    });
});

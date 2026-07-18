import { describe, it, expect } from 'vitest';
import { contentToText } from '@/lib/agent/agent-shared';

describe('contentToText', () => {
    it('passes strings through', () => {
        expect(contentToText('["a","b"]')).toBe('["a","b"]');
    });
    it('extracts text blocks from block arrays (Claude Sonnet 5 shape)', () => {
        expect(contentToText([
            { type: 'text', text: '["Step 1", ' },
            { type: 'text', text: '"Step 2"]' },
        ])).toBe('["Step 1", "Step 2"]');
    });
    it('ignores non-text blocks and tolerates mixed shapes', () => {
        expect(contentToText([
            { type: 'tool_use', id: 'x', name: 'y' },
            'plain',
            { type: 'text', text: '!' },
        ])).toBe('plain!');
    });
    it('handles null/undefined', () => {
        expect(contentToText(null)).toBe('');
        expect(contentToText(undefined)).toBe('');
    });
});

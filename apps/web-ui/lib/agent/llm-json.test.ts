import { describe, it, expect } from 'vitest';
import { contentToText, extractJsonObject } from './llm-json';

describe('contentToText', () => {
    it('passes plain strings through', () => {
        expect(contentToText('{"a":1}')).toBe('{"a":1}');
    });

    it('joins text blocks from a content-block array', () => {
        expect(
            contentToText([
                { type: 'text', text: '{"name":' },
                { type: 'text', text: '"X"}' },
            ]),
        ).toBe('{"name":"X"}');
    });

    it('drops thinking/reasoning blocks that carry no plain text', () => {
        expect(
            contentToText([
                { type: 'thinking', thinking: 'let me reason…' },
                { type: 'reasoning_content', reasoningContent: { text: 'hmm' } },
                { type: 'text', text: '{"ok":true}' },
            ]),
        ).toBe('{"ok":true}');
    });

    it('accepts bare-string entries and typeless text blocks', () => {
        expect(contentToText(['a', { text: 'b' }])).toBe('ab');
    });

    it('returns empty string for null/undefined', () => {
        expect(contentToText(null)).toBe('');
        expect(contentToText(undefined)).toBe('');
    });
});

describe('extractJsonObject', () => {
    const draft = { name: 'Check EC2 Fleet', tier: 'read-only' };

    it('parses a clean JSON object', () => {
        expect(extractJsonObject(JSON.stringify(draft))).toEqual(draft);
    });

    it('strips markdown fences', () => {
        expect(extractJsonObject('```json\n' + JSON.stringify(draft) + '\n```')).toEqual(draft);
    });

    it('tolerates leading and trailing prose around the object', () => {
        const raw = `Here is the JSON you asked for:\n${JSON.stringify(draft)}\nLet me know if you need changes.`;
        expect(extractJsonObject(raw)).toEqual(draft);
    });

    it('parses nested objects via the outermost brace span', () => {
        const nested = { name: 'X', meta: { a: { b: 1 } } };
        expect(extractJsonObject(`preamble ${JSON.stringify(nested)}`)).toEqual(nested);
    });

    it('returns null for a bare array (not an object)', () => {
        expect(extractJsonObject('["step one", "step two"]')).toBeNull();
    });

    it('returns null when nothing parses', () => {
        expect(extractJsonObject('no json here at all')).toBeNull();
    });
});

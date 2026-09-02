import { describe, it, expect } from 'vitest';
import { chunkText, recursiveSplit, forceChunk, CHUNK_SIZE, CHUNK_OVERLAP } from './chunking.js';

describe('recursiveSplit', () => {
    it('returns the whole text as a single chunk when it already fits', () => {
        expect(recursiveSplit('short text', 100, ['\n\n', '\n', '. ', ' '])).toEqual(['short text']);
    });

    it('returns an empty array for whitespace-only text that fits', () => {
        expect(recursiveSplit('   ', 100, ['\n\n', '\n', '. ', ' '])).toEqual([]);
    });

    it('splits on the first separator that appears in the text', () => {
        const text = 'a'.repeat(30) + '\n\n' + 'b'.repeat(30);
        const parts = recursiveSplit(text, 40, ['\n\n', '\n', '. ', ' ']);
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.every((p) => p.length <= 40)).toBe(true);
    });

    it('force-chunks by character count when no separator is present', () => {
        const text = 'x'.repeat(2000);
        const parts = recursiveSplit(text, 300, []);
        expect(parts.every((p) => p.length <= 300)).toBe(true);
        expect(parts.join('').length).toBeGreaterThanOrEqual(text.length);
    });

    it('recurses into the next separator when a split part is itself too large', () => {
        const big = 'word '.repeat(200); // space-separated, no newlines, > 300 chars
        const text = `${big}\n\nshort`;
        const parts = recursiveSplit(text, 300, ['\n\n', ' ']);
        expect(parts.every((p) => p.length <= 300)).toBe(true);
    });

    it('carries trailing overlap from the previous chunk into the next', () => {
        const text = 'A'.repeat(250) + '\n\n' + 'B'.repeat(250);
        const parts = recursiveSplit(text, 300, ['\n\n']);
        expect(parts.length).toBe(2);
        // second chunk should start with the tail of the first (overlap), not just "B"s
        expect(parts[1].startsWith('A')).toBe(true);
    });

    it('drops empty/whitespace-only fragments from the result', () => {
        const text = 'first'.repeat(100) + '\n\n\n\n' + 'second'.repeat(100);
        const parts = recursiveSplit(text, 300, ['\n\n', '\n']);
        expect(parts.every((p) => p.trim().length > 0)).toBe(true);
    });
});

// forceChunk's sliding window (i += max - CHUNK_OVERLAP) only advances for max >
// CHUNK_OVERLAP (200) — the only way it's ever invoked in production, via chunkText's
// fixed CHUNK_SIZE (1500). A max at or below the overlap is an invalid call, not a case
// this pure function is expected to handle.
describe('forceChunk', () => {
    it('slices text into fixed-size windows advancing by (max - overlap)', () => {
        const text = '0'.repeat(1000);
        const max = 300;
        const parts = forceChunk(text, max);
        expect(parts[0]).toBe(text.slice(0, max));
        const step = max - CHUNK_OVERLAP;
        expect(parts[1]).toBe(text.slice(step, step + max));
    });

    it('produces a single chunk when text is shorter than max', () => {
        expect(forceChunk('short', 1000)).toEqual(['short']);
    });
});

describe('chunkText', () => {
    it('prefixes each chunk with a document/index header and a stable content hash', () => {
        const chunks = chunkText('a small document body', 'notes.md');
        expect(chunks).toHaveLength(1);
        expect(chunks[0].text).toMatch(/^Document: notes\.md \| Chunk 1\/1\n\n/);
        expect(chunks[0].index).toBe(0);
        expect(chunks[0].total).toBe(1);
        expect(chunks[0].contentHash).toHaveLength(16);
    });

    it('produces the same contentHash for the same underlying text across two runs', () => {
        const [a] = chunkText('identical content', 'doc.md');
        const [b] = chunkText('identical content', 'doc.md');
        expect(a.contentHash).toBe(b.contentHash);
    });

    it('produces a different contentHash for different underlying text', () => {
        const [a] = chunkText('content one', 'doc.md');
        const [b] = chunkText('content two', 'doc.md');
        expect(a.contentHash).not.toBe(b.contentHash);
    });

    it('splits a long document into multiple sequentially indexed chunks', () => {
        const longText = ('paragraph text. '.repeat(50) + '\n\n').repeat(5);
        const chunks = chunkText(longText, 'long.md');
        expect(chunks.length).toBeGreaterThan(1);
        chunks.forEach((c, i) => {
            expect(c.index).toBe(i);
            expect(c.total).toBe(chunks.length);
        });
    });

    it('keeps every chunk within CHUNK_SIZE plus the header overhead', () => {
        const longText = 'word '.repeat(2000);
        const chunks = chunkText(longText, 'doc.md');
        for (const c of chunks) {
            const body = c.text.replace(/^Document: doc\.md \| Chunk \d+\/\d+\n\n/, '');
            expect(body.length).toBeLessThanOrEqual(CHUNK_SIZE);
        }
    });
});

import { describe, it, expect } from 'vitest';
import { dropDuplicateAnswers } from './dedupe-answers';

const LONG_ANSWER = 'x'.repeat(800);

describe('dropDuplicateAnswers', () => {
    it('keeps a single occurrence of every message when nothing repeats', () => {
        const messages = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'short answer' },
        ];
        expect(dropDuplicateAnswers(messages)).toEqual(messages);
    });

    it('drops a later exact-duplicate long assistant answer (finalNode promotion re-emit)', () => {
        const messages = [
            { role: 'assistant', content: LONG_ANSWER },
            { role: 'assistant', content: LONG_ANSWER },
        ];
        const result = dropDuplicateAnswers(messages);
        expect(result).toHaveLength(1);
    });

    it('does not dedupe a short repeated assistant message (below the promotion floor)', () => {
        const messages = [
            { role: 'assistant', content: 'Now pulling CloudWatch metrics.' },
            { role: 'assistant', content: 'Now pulling CloudWatch metrics.' },
        ];
        expect(dropDuplicateAnswers(messages)).toHaveLength(2);
    });

    it('never dedupes a turn that called tools, even if long and repeated', () => {
        const messages = [
            { role: 'assistant', content: LONG_ANSWER, parts: [{ type: 'tool-invocation' }] },
            { role: 'assistant', content: LONG_ANSWER, parts: [{ type: 'tool-invocation' }] },
        ];
        expect(dropDuplicateAnswers(messages)).toHaveLength(2);
    });

    it('computes answer text from text parts when present, ignoring content', () => {
        const messages = [
            { role: 'assistant', content: 'irrelevant', parts: [{ type: 'text', text: LONG_ANSWER }] },
            { role: 'assistant', content: 'also irrelevant', parts: [{ type: 'text', text: LONG_ANSWER }] },
        ];
        expect(dropDuplicateAnswers(messages)).toHaveLength(1);
    });
});

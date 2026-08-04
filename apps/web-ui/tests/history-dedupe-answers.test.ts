import { describe, it, expect } from 'vitest';
import { dropDuplicateAnswers } from '@/app/api/threads/[threadId]/history/dedupe-answers';

const report = `# Aurora Serverless V2 Health Report\n\n${'Cluster is GREEN. '.repeat(60)}`;

const answer = (id: string, text: string, extra: Array<Record<string, unknown>> = []) => ({
    id,
    role: 'assistant' as const,
    content: text,
    parts: [...extra, { type: 'text', text }],
});

describe('dropDuplicateAnswers', () => {
    it('drops the promoted final copy and keeps the execution original', () => {
        const msgs = [
            { id: 'u', role: 'user' as const, content: 'analyze it', parts: [{ type: 'text', text: 'analyze it' }] },
            answer('exec', report),
            answer('final', report, [{ type: 'data-phase', data: { phase: 'final' } }]),
        ];
        const out = dropDuplicateAnswers(msgs);
        expect(out.map((m) => m.id)).toEqual(['u', 'exec']);
    });

    it('keeps a genuine fallback answer that differs from the execution text', () => {
        const msgs = [
            answer('exec', report),
            answer('final', "I wasn't able to produce the Aurora analysis you requested. " + 'x'.repeat(900)),
        ];
        expect(dropDuplicateAnswers(msgs).map((m) => m.id)).toEqual(['exec', 'final']);
    });

    it('tolerates the trailing-whitespace difference between the two stored copies', () => {
        const msgs = [answer('exec', report), answer('final', `\n${report}  `)];
        expect(dropDuplicateAnswers(msgs).map((m) => m.id)).toEqual(['exec']);
    });

    it('leaves short repeated narration alone', () => {
        const msgs = [answer('a', 'Now pulling CloudWatch metrics.'), answer('b', 'Now pulling CloudWatch metrics.')];
        expect(dropDuplicateAnswers(msgs).map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('never drops a message carrying tool calls, even if its text repeats', () => {
        const msgs = [
            answer('exec', report),
            answer('withTool', report, [{ type: 'tool-invocation', toolCallId: 't1', toolName: 'execute_command' }]),
        ];
        expect(dropDuplicateAnswers(msgs).map((m) => m.id)).toEqual(['exec', 'withTool']);
    });

    it('does not touch user or tool messages', () => {
        const long = 'y'.repeat(900);
        const msgs = [
            { id: 'u1', role: 'user' as const, content: long, parts: [{ type: 'text', text: long }] },
            { id: 'u2', role: 'user' as const, content: long, parts: [{ type: 'text', text: long }] },
            { id: 't1', role: 'tool' as const, content: long, parts: [{ type: 'text', text: long }] },
        ];
        expect(dropDuplicateAnswers(msgs).map((m) => m.id)).toEqual(['u1', 'u2', 't1']);
    });
});

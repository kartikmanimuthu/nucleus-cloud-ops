import { describe, it, expect, vi, beforeEach } from 'vitest';

async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
    for (const item of items) yield item;
}

const streamMock = vi.hoisted(() => vi.fn());
const compileMock = vi.hoisted(() => vi.fn(() => ({ stream: streamMock })));
vi.mock('./graph', () => ({ createTextToSQLGraph: vi.fn(() => ({ stream: streamMock })) }));

const resolveDefaultModelConfigMock = vi.hoisted(() => vi.fn());
vi.mock('../model-resolver', () => ({ resolveDefaultModelConfig: resolveDefaultModelConfigMock }));

vi.mock('../provider-errors', () => ({
    isProviderConfigError: (err: unknown) => err instanceof Error && err.name === 'ProviderConfigError',
}));

import { invokeTextToSQL } from './index';

async function collect(input: Parameters<typeof invokeTextToSQL>[0]) {
    const events = [];
    for await (const ev of invokeTextToSQL(input)) events.push(ev);
    return events;
}

describe('invokeTextToSQL', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolveDefaultModelConfigMock.mockResolvedValue({ provider: 'bedrock', modelId: 'claude' });
    });

    it('yields a provider-config error then done when model resolution fails with a ProviderConfigError', async () => {
        const err = new Error('no provider configured');
        err.name = 'ProviderConfigError';
        resolveDefaultModelConfigMock.mockRejectedValue(err);

        const events = await collect({ question: 'q', tenantId: 't1' });

        expect(events).toEqual([
            { type: 'error', message: 'no provider configured' },
            { type: 'done' },
        ]);
        expect(streamMock).not.toHaveBeenCalled();
    });

    it('yields an error then done for a generic Error during model resolution', async () => {
        resolveDefaultModelConfigMock.mockRejectedValue(new Error('boom'));
        const events = await collect({ question: 'q', tenantId: 't1' });
        expect(events[0]).toEqual({ type: 'error', message: 'boom' });
    });

    it('stringifies a non-Error thrown during model resolution', async () => {
        resolveDefaultModelConfigMock.mockRejectedValue('raw failure');
        const events = await collect({ question: 'q', tenantId: 't1' });
        expect(events[0]).toEqual({ type: 'error', message: 'raw failure' });
    });

    it('emits step + sql events for generate_sql', async () => {
        streamMock.mockResolvedValue(asyncGen([{ generate_sql: { generatedSQL: 'SELECT 1', iteration: 1 } }]));
        const events = await collect({ question: 'q', tenantId: 't1' });
        expect(events).toContainEqual({ type: 'step', step: 'generate_sql', status: 'done' });
        expect(events).toContainEqual({ type: 'sql', query: 'SELECT 1' });
        expect(events[events.length - 1]).toEqual({ type: 'done' });
    });

    it('does not emit a sql event when generate_sql update has no generatedSQL', async () => {
        streamMock.mockResolvedValue(asyncGen([{ generate_sql: {} }]));
        const events = await collect({ question: 'q', tenantId: 't1' });
        expect(events.some(e => e.type === 'sql')).toBe(false);
    });

    it('emits a result event with a 5-row preview for execute_sql success', async () => {
        const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
        streamMock.mockResolvedValue(asyncGen([{ execute_sql: { sqlResult: { rows, rowCount: 10 } } }]));
        const events = await collect({ question: 'q', tenantId: 't1' });
        const resultEvent = events.find(e => e.type === 'result') as any;
        expect(resultEvent.rowCount).toBe(10);
        expect(resultEvent.preview).toHaveLength(5);
    });

    it('emits a detail:error step when execute_sql produced a sqlError', async () => {
        streamMock.mockResolvedValue(asyncGen([{ execute_sql: { sqlError: 'bad sql' } }]));
        const events = await collect({ question: 'q', tenantId: 't1' });
        expect(events).toContainEqual({ type: 'step', step: 'execute_sql', status: 'done', detail: 'error' });
    });

    it('emits a reflection event with feedback and iteration', async () => {
        streamMock.mockResolvedValue(asyncGen([{ reflect: { satisfied: false, reflectionFeedback: 'try again', iteration: 2 } }]));
        const events = await collect({ question: 'q', tenantId: 't1' });
        expect(events).toContainEqual({ type: 'reflection', satisfied: false, feedback: 'try again', iteration: 2 });
    });

    it('defaults reflection feedback to empty string and falls back to lastIteration when satisfied but no iteration on the update', async () => {
        streamMock.mockResolvedValue(asyncGen([
            { generate_sql: { generatedSQL: 'SELECT 1', iteration: 1 } },
            { reflect: { satisfied: true } },
        ]));
        const events = await collect({ question: 'q', tenantId: 't1' });
        const reflection = events.find(e => e.type === 'reflection') as any;
        expect(reflection.feedback).toBe('');
        expect(reflection.iteration).toBe(1);
    });

    it('does not emit a reflection event when satisfied is undefined', async () => {
        streamMock.mockResolvedValue(asyncGen([{ reflect: {} }]));
        const events = await collect({ question: 'q', tenantId: 't1' });
        expect(events.some(e => e.type === 'reflection')).toBe(false);
    });

    it('emits a token event for the synthesized final answer', async () => {
        streamMock.mockResolvedValue(asyncGen([{ synthesize: { finalAnswer: 'You have 3 EC2 instances.' } }]));
        const events = await collect({ question: 'q', tenantId: 't1' });
        expect(events).toContainEqual({ type: 'token', content: 'You have 3 EC2 instances.' });
    });

    it('does not emit a token event when synthesize has no finalAnswer', async () => {
        streamMock.mockResolvedValue(asyncGen([{ synthesize: {} }]));
        const events = await collect({ question: 'q', tenantId: 't1' });
        expect(events.some(e => e.type === 'token')).toBe(false);
    });

    it('catches a graph stream error and yields an error then done', async () => {
        streamMock.mockRejectedValue(new Error('stream exploded'));
        const events = await collect({ question: 'q', tenantId: 't1' });
        expect(events).toEqual([
            { type: 'error', message: 'stream exploded' },
            { type: 'done' },
        ]);
    });

    it('passes filters and conversation history through to graph.stream', async () => {
        streamMock.mockResolvedValue(asyncGen([]));
        await collect({
            question: 'q', tenantId: 't1',
            conversationHistory: [{ role: 'user', content: 'earlier' }],
            filters: { region: 'us-east-1' },
        });
        expect(streamMock).toHaveBeenCalledWith(
            expect.objectContaining({
                question: 'q', tenantId: 't1', maxIterations: 3,
                conversationHistory: [{ role: 'user', content: 'earlier' }],
                filters: { region: 'us-east-1' },
                modelConfig: { provider: 'bedrock', modelId: 'claude' },
            }),
            { streamMode: 'updates' },
        );
    });
});

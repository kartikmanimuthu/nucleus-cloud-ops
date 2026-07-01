import { describe, it, expect } from 'vitest';
import { buildChatTranscript, TOOL_RESULT_CHAR_CAP, type ChatMessageLike } from './build-chat-transcript';

describe('buildChatTranscript', () => {
    it('includes text parts verbatim and untruncated', () => {
        const longText = 'a'.repeat(50_000);
        const messages: ChatMessageLike[] = [
            { role: 'user', parts: [{ type: 'text', text: longText }] },
        ];
        const result = buildChatTranscript(messages);
        expect(result).toBe(`USER: ${longText}`);
    });

    it('serializes a tool-invocation part with name, args, and result', () => {
        const messages: ChatMessageLike[] = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-invocation',
                        toolCallId: 'call_1',
                        toolName: 'execute_command',
                        args: { command: 'aws ce get-cost-and-usage' },
                        result: 'ok',
                    },
                ],
            },
        ];
        const result = buildChatTranscript(messages);
        expect(result).toBe(
            'ASSISTANT: TOOL_CALL: execute_command({"command":"aws ce get-cost-and-usage"})\nTOOL_RESULT: ok',
        );
    });

    it('caps a large tool result but keeps args in full', () => {
        const bigArgValue = 'x'.repeat(4_500);
        const bigResult = 'y'.repeat(5_000);
        const messages: ChatMessageLike[] = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-invocation',
                        toolCallId: 'call_2',
                        toolName: 'list_instances',
                        args: { note: bigArgValue },
                        result: bigResult,
                    },
                ],
            },
        ];
        const result = buildChatTranscript(messages);
        // args untouched, full length present
        expect(result).toContain(JSON.stringify({ note: bigArgValue }));
        // result capped at TOOL_RESULT_CHAR_CAP with a truncation marker
        expect(result).toContain('y'.repeat(TOOL_RESULT_CHAR_CAP));
        expect(result).not.toContain('y'.repeat(TOOL_RESULT_CHAR_CAP + 1));
        expect(result).toContain('[...truncated 1000 more chars]');
    });

    it('leaves a small tool result untouched', () => {
        const messages: ChatMessageLike[] = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-invocation',
                        toolCallId: 'call_3',
                        toolName: 'get_status',
                        args: {},
                        result: 'all good',
                    },
                ],
            },
        ];
        const result = buildChatTranscript(messages);
        expect(result).toContain('TOOL_RESULT: all good');
        expect(result).not.toContain('truncated');
    });

    it('interleaves text and tool parts in original order', () => {
        const messages: ChatMessageLike[] = [
            {
                role: 'assistant',
                parts: [
                    { type: 'text', text: 'Checking costs now.' },
                    {
                        type: 'tool-invocation',
                        toolCallId: 'call_4',
                        toolName: 'get_cost',
                        args: {},
                        result: '$100',
                    },
                    { type: 'text', text: 'Total spend is $100.' },
                ],
            },
        ];
        const result = buildChatTranscript(messages);
        const idxA = result.indexOf('Checking costs now.');
        const idxTool = result.indexOf('TOOL_CALL: get_cost');
        const idxB = result.indexOf('Total spend is $100.');
        expect(idxA).toBeGreaterThanOrEqual(0);
        expect(idxTool).toBeGreaterThan(idxA);
        expect(idxB).toBeGreaterThan(idxTool);
    });

    it('falls back to message.content when parts is empty or absent', () => {
        const messages: ChatMessageLike[] = [{ role: 'user', content: 'hello there' }];
        const result = buildChatTranscript(messages);
        expect(result).toBe('USER: hello there');
    });

    it('derives tool name from a "tool-<name>" part type when toolName/name are absent', () => {
        const messages: ChatMessageLike[] = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-execute_command',
                        toolCallId: 'call_5',
                        args: { command: 'ls' },
                        result: 'file.txt',
                    },
                ],
            },
        ];
        const result = buildChatTranscript(messages);
        expect(result).toContain('TOOL_CALL: execute command({"command":"ls"})');
    });

    it('joins multiple messages with a blank line between them', () => {
        const messages: ChatMessageLike[] = [
            { role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
            { role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] },
        ];
        const result = buildChatTranscript(messages);
        expect(result).toBe('USER: Hi\n\nASSISTANT: Hello');
    });
});

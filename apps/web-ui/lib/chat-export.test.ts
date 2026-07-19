import { describe, it, expect } from 'vitest';
import { stripInlineMarkdown, mdToPdfBlocks, formatMessagesAsMarkdown } from './chat-export';

describe('stripInlineMarkdown', () => {
    it('strips bold, italic, inline code, and link syntax', () => {
        expect(stripInlineMarkdown('**Site**: `smc` — see *notes* and [docs](https://x.y)')).toBe(
            'Site: smc — see notes and docs',
        );
    });

    it('leaves plain text untouched', () => {
        expect(stripInlineMarkdown('plain text, no markup')).toBe('plain text, no markup');
    });
});

describe('mdToPdfBlocks', () => {
    it('classifies headings with their level and strips inline markup', () => {
        const blocks = mdToPdfBlocks('# Big **Title**\n## Section');
        expect(blocks).toEqual([
            { kind: 'heading', level: 1, text: 'Big Title' },
            { kind: 'heading', level: 2, text: 'Section' },
        ]);
    });

    it('keeps fenced code as mono lines without the fence markers', () => {
        const blocks = mdToPdfBlocks('```json\n{ "a": 1 }\n```');
        expect(blocks).toEqual([{ kind: 'mono', text: '{ "a": 1 }' }]);
    });

    it('keeps table data rows as mono and drops the separator row', () => {
        const blocks = mdToPdfBlocks('| Ticket | Priority |\n|---|---|\n| DEV-1 | High |');
        expect(blocks).toEqual([
            { kind: 'mono', text: '| Ticket | Priority |' },
            { kind: 'mono', text: '| DEV-1 | High |' },
        ]);
    });

    it('normalizes bullets and keeps numbered-list markers', () => {
        const blocks = mdToPdfBlocks('- first **thing**\n2. second thing');
        expect(blocks).toEqual([
            { kind: 'bullet', text: '• first thing' },
            { kind: 'bullet', text: '2. second thing' },
        ]);
    });

    it('turns horizontal rules into gaps and collapses blank-line runs', () => {
        const blocks = mdToPdfBlocks('para one\n\n\n---\npara two');
        expect(blocks).toEqual([
            { kind: 'para', text: 'para one' },
            { kind: 'gap' },
            { kind: 'para', text: 'para two' },
        ]);
    });
});

describe('formatMessagesAsMarkdown', () => {
    it('unwraps double-escaped tool input instead of exporting the escaped wrapper', () => {
        const messages = [
            {
                id: 'm1',
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-execute_command',
                        toolCallId: 'tc1',
                        input: { input: '{"command":"aws sts get-caller-identity"}' },
                        output: 'ok',
                    },
                ],
            },
        ];

        const md = formatMessagesAsMarkdown(messages);
        expect(md).toContain('"command": "aws sts get-caller-identity"');
        expect(md).not.toContain('\\"command\\"');
    });
});

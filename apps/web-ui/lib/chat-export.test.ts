import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// jsPDF is real-browser/canvas-adjacent — mock it with a minimal fake that records what
// each export writes, so exportToPDF/exportReportToPDF/createPdfWriter's pagination logic
// runs for real against fake page geometry instead of skipping to 0% coverage.
const { mockSave, jsPdfInstances } = vi.hoisted(() => ({ mockSave: vi.fn(), jsPdfInstances: [] as any[] }));

vi.mock('jspdf', () => {
    class FakeJsPDF {
        calls: unknown[][] = [];
        pageCount = 1;
        internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
        constructor() { jsPdfInstances.push(this); }
        setFont(...args: unknown[]) { this.calls.push(['setFont', ...args]); }
        setFontSize(...args: unknown[]) { this.calls.push(['setFontSize', ...args]); }
        setTextColor(...args: unknown[]) { this.calls.push(['setTextColor', ...args]); }
        // Real jsPDF wraps to width; the fake just splits on newlines (blocks are
        // already one line each) so tests can force pagination with block COUNT.
        splitTextToSize(text: string) { return text.split('\n'); }
        text(...args: unknown[]) { this.calls.push(['text', ...args]); }
        addPage() { this.pageCount++; this.calls.push(['addPage']); }
        save(filename: string) { mockSave(filename); }
    }
    return { jsPDF: FakeJsPDF };
});

import { stripInlineMarkdown, mdToPdfBlocks, formatMessagesAsMarkdown, toPdfSafeText, exportToPDF, exportReportToPDF, copyToClipboard, exportToMarkdown } from './chat-export';

beforeEach(() => {
    mockSave.mockClear();
    jsPdfInstances.length = 0;
});

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

describe('toPdfSafeText', () => {
    it('drops emoji rather than letting them reach the WinAnsi font as raw UTF-16', () => {
        // 🙏 is D83D DE4F; untouched it renders as "Ø=ÞO" and spaces out the whole line.
        expect(toPdfSafeText('Haha, thank you! 🙏 Appreciate that! 😊')).toBe('Haha, thank you!  Appreciate that! ');
    });

    it('transliterates status glyphs that carry meaning', () => {
        expect(toPdfSafeText('✅ Healthy, ⚠ Degraded, ❌ Down')).toBe('[OK] Healthy, [!] Degraded, [X] Down');
        expect(toPdfSafeText('a → b, x ≥ y')).toBe('a -> b, x >= y');
        // U+2212 is not the ASCII hyphen, and WinAnsi predates the rupee sign;
        // dropping either silently changes the number's meaning.
        expect(toPdfSafeText('\u2212 12% and \u20b945,000')).toBe('- 12% and Rs.45,000');
    });

    it('keeps the WinAnsi repertoire, including punctuation above Latin-1', () => {
        expect(toPdfSafeText('em — dash, \u201Cquotes\u201D, bullet \u2022, caf\u00E9, \u00A35'))
            .toBe('em — dash, \u201Cquotes\u201D, bullet \u2022, caf\u00E9, \u00A35');
    });

    it('leaves whitespace alone so mono tables and code keep their alignment', () => {
        expect(toPdfSafeText('| a   |  b |\n\tindented')).toBe('| a   |  b |\n\tindented');
    });

    it('strips scripts the standard-14 fonts cannot draw', () => {
        expect(toPdfSafeText('hello \u0928\u092E\u0938\u094D\u0924\u0947')).toBe('hello ');
    });
});

// NOTE: isToolPart's `part.type?.startsWith('tool-') && part.type !== 'text'` right-hand
// side is provably unreachable \u2014 no string both starts with 'tool-' and equals 'text'.
// Left untested, same convention as other documented-unreachable branches this session.
describe('formatMessagesAsMarkdown \u2014 message shaping', () => {
    it('skips tool-role messages entirely', () => {
        const md = formatMessagesAsMarkdown([{ id: 'm1', role: 'tool', content: 'raw tool payload' }]);
        expect(md).not.toContain('raw tool payload');
    });

    it('labels user and agent turns with distinct headers', () => {
        const md = formatMessagesAsMarkdown([
            { id: 'm1', role: 'user', content: 'hi' },
            { id: 'm2', role: 'assistant', content: 'hello' },
        ]);
        expect(md).toContain('## \uD83D\uDC64 User');
        expect(md).toContain('## \uD83E\uDD16 Agent');
    });

    it('renders a reasoning part as a fenced "Thinking" block', () => {
        const md = formatMessagesAsMarkdown([
            { id: 'm1', role: 'assistant', parts: [{ type: 'reasoning', text: 'considering options' }] },
        ]);
        expect(md).toContain('**Thinking:**');
        expect(md).toContain('considering options');
    });

    it('renders a tool part with both input and output', () => {
        const md = formatMessagesAsMarkdown([{
            id: 'm1', role: 'assistant',
            parts: [{ type: 'tool-my_tool', toolCallId: 'tc1', args: { a: 1 }, result: 'done' }],
        }]);
        expect(md).toContain('**Tool: `my_tool`**');
        expect(md).toContain('*Input:*');
        expect(md).toContain('*Output:*');
        expect(md).toContain('done');
    });

    it('omits the Input/Output sections when a tool part has neither args nor a result', () => {
        const md = formatMessagesAsMarkdown([{
            id: 'm1', role: 'assistant', parts: [{ type: 'tool-my_tool', toolCallId: 'tc1' }],
        }]);
        expect(md).toContain('**Tool: `my_tool`**');
        expect(md).not.toContain('*Input:*');
        expect(md).not.toContain('*Output:*');
    });

    it('JSON-stringifies a non-string tool result', () => {
        const md = formatMessagesAsMarkdown([{
            id: 'm1', role: 'assistant', parts: [{ type: 'tool-my_tool', toolCallId: 'tc1', output: { ok: true } }],
        }]);
        expect(md).toContain('"ok": true');
    });

    it('names a dynamic-tool part by its own toolName field', () => {
        const md = formatMessagesAsMarkdown([{
            id: 'm1', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'search', toolCallId: 'tc1' }],
        }]);
        expect(md).toContain('**Tool: `search`**');
    });

    it('falls back to the type-derived tool name when toolName is absent', () => {
        const md = formatMessagesAsMarkdown([{
            id: 'm1', role: 'assistant', parts: [{ type: 'tool-execute_command', toolCallId: 'tc1' }],
        }]);
        expect(md).toContain('**Tool: `execute_command`**');
    });

    it('falls back to a stringified content field when parts yields no content', () => {
        const md = formatMessagesAsMarkdown([{ id: 'm1', role: 'assistant', content: 'plain reply' }]);
        expect(md).toContain('plain reply');
    });

    it('JSON-stringifies a non-string content field', () => {
        const md = formatMessagesAsMarkdown([{ id: 'm1', role: 'assistant', content: { note: 'x' } }]);
        expect(md).toContain('"note":"x"');
    });

    it('omits the content line entirely for a message with only whitespace content', () => {
        const md = formatMessagesAsMarkdown([{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: '   ' }] }]);
        const lines = md.split('\n');
        expect(lines.filter((l) => l.trim() === '   ')).toHaveLength(0);
    });

    it('ignores a part that is neither text, reasoning, nor a tool call', () => {
        const md = formatMessagesAsMarkdown([{ id: 'm1', role: 'assistant', content: 'fallback', parts: [{ type: 'step-start' }] }]);
        expect(md).toContain('fallback'); // falls through to the content-string fallback
    });

    it('names a tool part "Unknown" when it has a toolCallId but a non-"tool-" type and no toolName', () => {
        const md = formatMessagesAsMarkdown([{
            id: 'm1', role: 'assistant', parts: [{ type: 'something-else', toolCallId: 'tc1', output: 'x' }],
        }]);
        expect(md).toContain('**Tool: `Unknown`**');
    });

    it('honors a supplied timeZone for the export timestamp', () => {
        const md = formatMessagesAsMarkdown([], 'Asia/Kolkata');
        expect(md).toContain('Exported on');
    });
});

describe('copyToClipboard', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('writes the formatted markdown to the clipboard and returns true', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });

        const result = await copyToClipboard([{ id: 'm1', role: 'user', content: 'hi' }]);

        expect(result).toBe(true);
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining('hi'));
    });

    it('returns false when the clipboard write is rejected', async () => {
        vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const result = await copyToClipboard([{ id: 'm1', role: 'user', content: 'hi' }]);

        expect(result).toBe(false);
        consoleSpy.mockRestore();
    });
});

describe('exportToMarkdown', () => {
    afterEach(() => vi.unstubAllGlobals());

    function stubDom() {
        const link = { href: '', download: '', click: vi.fn() };
        const body = { appendChild: vi.fn(), removeChild: vi.fn() };
        vi.stubGlobal('document', { createElement: vi.fn().mockReturnValue(link), body });
        vi.stubGlobal('URL', { createObjectURL: vi.fn().mockReturnValue('blob:fake'), revokeObjectURL: vi.fn() });
        return { link, body };
    }

    it('creates a download link named after the thread, clicks it, then cleans up', async () => {
        const { link, body } = stubDom();

        const result = await exportToMarkdown([{ id: 'm1', role: 'user', content: 'hi' }], 'thread-123');

        expect(result).toBe(true);
        expect(link.download).toContain('chat_thread-123_');
        expect(link.click).toHaveBeenCalledOnce();
        expect(body.appendChild).toHaveBeenCalledWith(link);
        expect(body.removeChild).toHaveBeenCalledWith(link);
        expect((globalThis.URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    });

    it('returns false and logs when the DOM download flow throws', async () => {
        vi.stubGlobal('document', { createElement: vi.fn(() => { throw new Error('no DOM'); }) });
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const result = await exportToMarkdown([], 'thread-123');

        expect(result).toBe(false);
        consoleSpy.mockRestore();
    });
});

describe('exportToPDF', () => {
    it('writes a header and one section per non-tool message, then saves', async () => {
        const messages = [
            { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'What is the status?' }] },
            { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'All green.' }] },
            { id: 'm3', role: 'tool', content: 'raw' },
        ];

        const result = await exportToPDF(messages, 'thread-1');

        expect(result).toBe(true);
        expect(mockSave).toHaveBeenCalledWith(expect.stringContaining('chat_thread-1_'));
        const instance = jsPdfInstances[0];
        const textCalls = instance.calls.filter((c: unknown[]) => c[0] === 'text').map((c: unknown[]) => c[1]);
        expect(textCalls).toContain('What is the status?');
        expect(textCalls).toContain('All green.');
        expect(textCalls.some((t: string) => t.includes('raw'))).toBe(false); // tool-role message skipped
    });

    it('skips a message whose parts yield zero blocks', async () => {
        const messages = [{ id: 'm1', role: 'assistant', parts: [] }];
        const result = await exportToPDF(messages, 'thread-1');
        expect(result).toBe(true);
        const instance = jsPdfInstances[0];
        // Only the header's own text (title + note) was written \u2014 no "User"/"Agent" label for this message.
        const labels = instance.calls.filter((c: unknown[]) => c[0] === 'setTextColor');
        expect(labels.length).toBeGreaterThan(0); // header still writes
    });

    it('renders a tool part as a labeled block with capped input/output', async () => {
        const messages = [{
            id: 'm1', role: 'assistant',
            parts: [{ type: 'tool-execute_command', toolCallId: 'tc1', input: { cmd: 'ls' }, output: 'x'.repeat(3000) }],
        }];

        await exportToPDF(messages, 'thread-1');
        const instance = jsPdfInstances[0];
        const monoCalls = instance.calls.filter((c: unknown[]) => c[0] === 'text').map((c: unknown[]) => c[1]);
        expect(monoCalls.some((t: string) => t.includes('(truncated)'))).toBe(true);
    });

    it('paginates to a second page when content overflows the first', async () => {
        const longBody = Array.from({ length: 150 }, (_, i) => `paragraph line ${i}`).join('\n');
        const messages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: longBody }] }];

        await exportToPDF(messages, 'thread-1');
        expect(jsPdfInstances[0].pageCount).toBeGreaterThan(1);
    });

    // NOTE: PdfBlock.level is always 1-6 (mdToPdfBlocks' heading regex is `#{1,6}`), so
    // HEADING_SIZES[block.level] ?? 10 — every key 1-6 is present — never falls to its
    // ?? 10 default. Left untested as provably unreachable, same convention as other
    // documented-unreachable branches this session.

    it('gives a level-3+ heading the smaller top margin than an h1/h2', async () => {
        const messages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: '### Deep heading' }] }];
        await exportToPDF(messages, 'thread-1');
        const instance = jsPdfInstances[0];
        const textCalls = instance.calls.filter((c: unknown[]) => c[0] === 'text').map((c: unknown[]) => c[1]);
        expect(textCalls).toContain('Deep heading');
    });

    it('renders bulleted list lines through the mono/bullet write path', async () => {
        const messages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: '- one\n- two' }] }];
        await exportToPDF(messages, 'thread-1');
        const instance = jsPdfInstances[0];
        const textCalls = instance.calls.filter((c: unknown[]) => c[0] === 'text').map((c: unknown[]) => c[1]);
        expect(textCalls).toContain('• one');
        expect(textCalls).toContain('• two');
    });

    it('renders a reasoning part as a "Thinking" note block', async () => {
        const messages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'reasoning', text: 'weighing options' }] }];
        await exportToPDF(messages, 'thread-1');
        const instance = jsPdfInstances[0];
        const textCalls = instance.calls.filter((c: unknown[]) => c[0] === 'text').map((c: unknown[]) => c[1]);
        expect(textCalls.some((t: string) => t.includes('Thinking: weighing options'))).toBe(true);
    });

    it('ignores a part whose type is neither text, reasoning, nor a tool call', async () => {
        const messages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'step-start' }] }];
        const result = await exportToPDF(messages, 'thread-1');
        expect(result).toBe(true); // no throw, message just contributes zero blocks
    });

    it('renders a tool part with an object result and no args', async () => {
        const messages = [{
            id: 'm1', role: 'assistant',
            parts: [{ type: 'tool-execute_command', toolCallId: 'tc1', output: { ok: true } }],
        }];
        await exportToPDF(messages, 'thread-1');
        const instance = jsPdfInstances[0];
        const textCalls = instance.calls.filter((c: unknown[]) => c[0] === 'text').map((c: unknown[]) => c[1]);
        expect(textCalls.some((t: string) => t.includes('"ok": true'))).toBe(true);
    });

    it('renders a tool part with args but no result at all', async () => {
        const messages = [{
            id: 'm1', role: 'assistant',
            parts: [{ type: 'tool-execute_command', toolCallId: 'tc1', input: { cmd: 'ls' } }],
        }];
        const result = await exportToPDF(messages, 'thread-1');
        expect(result).toBe(true);
        const instance = jsPdfInstances[0];
        const textCalls = instance.calls.filter((c: unknown[]) => c[0] === 'text').map((c: unknown[]) => c[1]);
        expect(textCalls.some((t: string) => t.includes('"cmd": "ls"'))).toBe(true);
    });

    it('falls back to the raw content string when a message has no parts', async () => {
        const messages = [{ id: 'm1', role: 'assistant', content: '# Heading only\nbody text' }];
        await exportToPDF(messages, 'thread-1');
        const instance = jsPdfInstances[0];
        const textCalls = instance.calls.filter((c: unknown[]) => c[0] === 'text').map((c: unknown[]) => c[1]);
        expect(textCalls).toContain('Heading only');
        expect(textCalls).toContain('body text');
    });

    it('returns false and logs when PDF generation throws', async () => {
        const messages = [{ id: 'm1', role: 'user', content: 'x' }];
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockSave.mockImplementationOnce(() => { throw new Error('save failed'); });

        const result = await exportToPDF(messages, 'thread-1');

        expect(result).toBe(false);
        consoleSpy.mockRestore();
    });
});

describe('exportReportToPDF', () => {
    it('returns false when there is no assistant message with real text', async () => {
        const result = await exportReportToPDF(
            [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: '   ' }] }],
            'thread-1',
        );
        expect(result).toBe(false);
        expect(mockSave).not.toHaveBeenCalled();
    });

    it('exports only the LAST assistant answer, joining its multiple text parts', async () => {
        const messages = [
            { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'stale answer' }] },
            { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'follow up' }] },
            {
                id: 'm3', role: 'assistant',
                parts: [{ type: 'text', text: 'final part one' }, { type: 'text', text: 'final part two' }],
            },
        ];

        const result = await exportReportToPDF(messages, 'thread-1');

        expect(result).toBe(true);
        expect(mockSave).toHaveBeenCalledWith(expect.stringContaining('report_thread-1_'));
        const instance = jsPdfInstances[0];
        const textCalls = instance.calls.filter((c: unknown[]) => c[0] === 'text').map((c: unknown[]) => c[1]);
        expect(textCalls).toContain('final part one');
        expect(textCalls).toContain('final part two');
        expect(textCalls.some((t: string) => t.includes('stale answer'))).toBe(false);
    });

    it('returns false and logs when PDF generation throws', async () => {
        const messages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] }];
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockSave.mockImplementationOnce(() => { throw new Error('save failed'); });

        const result = await exportReportToPDF(messages, 'thread-1');

        expect(result).toBe(false);
        consoleSpy.mockRestore();
    });
});

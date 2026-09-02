/**
 * Contract tests for the shared PDF engine.
 *
 * Both AI Ops (chat + report) and Agent Ops (run report) render through this
 * module, so these assertions are the single definition of how either export
 * treats a character or a line of markdown.
 */

import { describe, it, expect } from 'vitest';
import { toPdfSafeText, stripInlineMarkdown, mdToPdfBlocks, cap } from './pdf-blocks';

describe('toPdfSafeText', () => {
    it('transliterates comparison operators rather than dropping them', () => {
        // Dropping one inverts a threshold: "CPU >= 80%" would read "CPU 80%".
        expect(toPdfSafeText('CPU ≥ 80%')).toBe('CPU >= 80%');
        expect(toPdfSafeText('latency ≤ 250ms')).toBe('latency <= 250ms');
        expect(toPdfSafeText('state ≠ running')).toBe('state != running');
        expect(toPdfSafeText('≈ $500/mo')).toBe('~ $500/mo');
    });

    it('transliterates the minus sign, which is not the ASCII hyphen', () => {
        // U+2212 dropped silently turns a saving into a cost.
        expect(toPdfSafeText('− 12% spend')).toBe('- 12% spend');
    });

    it('transliterates the rupee sign, which WinAnsi predates', () => {
        // GBP/JPY/EUR survive because WinAnsi carries them; INR would have lost
        // its symbol and left a bare number.
        expect(toPdfSafeText('₹45,000 / month')).toBe('Rs.45,000 / month');
        expect(toPdfSafeText('£5 ¥5 €5')).toBe('£5 ¥5 €5');
    });

    it('replaces status glyphs with bracketed markers', () => {
        expect(toPdfSafeText('✅ Healthy, ⚠ Degraded, ❌ Down')).toBe('[OK] Healthy, [!] Degraded, [X] Down');
        expect(toPdfSafeText('\u{1F534} crit \u{1F7E2} ok \u{1F535} info')).toBe('[CRITICAL] crit [OK] ok [INFO] info');
    });

    it('keeps the punctuation WinAnsi actually carries', () => {
        const s = 'em — dash, “quotes”, bullet •, café';
        expect(toPdfSafeText(s)).toBe(s);
    });

    it('drops what no standard-14 font can draw, leaving no stray bytes', () => {
        // A surrogate pair reaching jsPDF is what produced "Ø=ÞO" on the page.
        expect(toPdfSafeText('report \u{1F3AF} done')).toBe('report  done');
        expect(toPdfSafeText('hello नमस्ते')).toBe('hello ');
        expect(toPdfSafeText('a‍b')).toBe('ab');     // zero-width joiner
    });

    it('preserves tabs and newlines, which alignment depends on', () => {
        expect(toPdfSafeText('| a   |  b |\n\tindented')).toBe('| a   |  b |\n\tindented');
    });
});

describe('stripInlineMarkdown', () => {
    it('removes emphasis, code and link syntax but keeps the text', () => {
        expect(stripInlineMarkdown('**bold** and `code` and [link](http://x)')).toBe('bold and code and link');
    });
});

describe('mdToPdfBlocks', () => {
    it('classifies headings by level', () => {
        expect(mdToPdfBlocks('## Issues Found')).toEqual([{ kind: 'heading', level: 2, text: 'Issues Found' }]);
    });

    it('keeps table rows as monospace and drops the separator row', () => {
        const blocks = mdToPdfBlocks('| A | B |\n|---|---|\n| 1 | 2 |');
        expect(blocks).toEqual([
            { kind: 'mono', text: '| A | B |' },
            { kind: 'mono', text: '| 1 | 2 |' },
        ]);
    });

    it('normalises list markers and keeps ordered numbering', () => {
        expect(mdToPdfBlocks('- first')).toEqual([{ kind: 'bullet', text: '• first' }]);
        expect(mdToPdfBlocks('2. second')).toEqual([{ kind: 'bullet', text: '2. second' }]);
    });

    it('sets fenced code in monospace without the fence markers', () => {
        expect(mdToPdfBlocks('```bash\naws ec2 stop\n```')).toEqual([{ kind: 'mono', text: 'aws ec2 stop' }]);
    });

    it('collapses a horizontal rule and runs of blank lines to a single gap', () => {
        expect(mdToPdfBlocks('a\n\n\n---\n\nb')).toEqual([
            { kind: 'para', text: 'a' },
            { kind: 'gap' },
            { kind: 'para', text: 'b' },
        ]);
    });
});

describe('cap', () => {
    it('marks a truncated payload rather than cutting silently', () => {
        expect(cap('abcdef', 3)).toBe('abc\n… (truncated)');
        expect(cap('abc', 10)).toBe('abc');
    });
});

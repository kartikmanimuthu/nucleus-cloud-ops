/**
 * Shared PDF engine — the single renderer behind BOTH the AI Ops chat/report
 * exports and the Agent Ops run report.
 *
 * It was AI Ops's engine first; Agent Ops was ported onto it so the two modules
 * emit one consistent document. Everything a caller needs is here: the WinAnsi
 * transliteration rules, the line-based markdown classifier, the block model,
 * and the paginating writer. Callers assemble PdfBlock[] and hand it to
 * createPdfWriter() — no caller talks to jsPDF directly.
 *
 * ── WHY THE SANITISER IS NOT OPTIONAL ───────────────────────────────────────
 * The standard-14 PDF fonts jsPDF draws with (helvetica/courier) use
 * WinAnsiEncoding — one byte per glyph. Anything above it is emitted as raw
 * UTF-16 bytes and drawn as Latin-1: an emoji's D83D DE4F surfaces as "Ø=ÞO",
 * and jsPDF switches that whole string to two-bytes-per-char, which is what
 * spaces the line out ("H a h a"). Both symptoms have one cause, so one filter
 * in writeText fixes both for every block kind and every export.
 *
 * Embedding a Unicode TTF is the alternative; it costs ~300KB of bundle and
 * still cannot render colour emoji, so decoration is dropped and the glyphs
 * that carry meaning are transliterated.
 */


/** Cap long tool payloads in PDFs so a scan-heavy run stays a readable file. */
export const PDF_TOOL_IO_CAP = 2000;

const WINANSI_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

const PDF_SYMBOL_MAP: Record<string, string> = {
    '✅': '[OK]', '✔': '[OK]', '✓': '[OK]', '☑': '[OK]',
    '❌': '[X]', '✖': '[X]', '✗': '[X]',
    '⚠': '[!]', '❗': '[!]', '‼': '[!]',
    '🔴': '[CRITICAL]', '🟠': '[WARN]', '🟡': '[WARN]', '🟢': '[OK]', '🔵': '[INFO]',
    '→': '->', '←': '<-', '⇒': '=>', '↑': '^', '↓': 'v',
    '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~',
    // U+2212 MINUS SIGN is not the ASCII hyphen, and WinAnsi predates the
    // rupee sign — dropping either silently changes what a number means.
    '−': '-', '₹': 'Rs.',
};

/** Reduce text to what the standard-14 fonts can actually draw. Exported for tests. */
export function toPdfSafeText(text: string): string {
    let out = '';
    // Iterating a string yields whole code points, so a surrogate pair is one
    // step — never half an emoji.
    for (const ch of text) {
        const mapped = PDF_SYMBOL_MAP[ch];
        if (mapped !== undefined) { out += mapped; continue; }
        const cp = ch.codePointAt(0)!;
        // Tabs/newlines pass through: splitTextToSize and the mono blocks rely
        // on them, and whitespace is deliberately left alone so table columns
        // and code indentation keep their alignment.
        if (cp === 0x09 || cp === 0x0a) { out += ch; continue; }
        if (cp >= 0x20 && cp <= 0x7e) { out += ch; continue; }
        if (cp >= 0xa0 && cp <= 0xff) { out += ch; continue; }
        if (WINANSI_EXTRAS.has(ch)) { out += ch; continue; }
        // Unrepresentable — emoji, CJK, variation selectors, ZWJ. Dropping is
        // what keeps the rest of the line in single-byte encoding.
    }
    return out;
}

/** Truncate an oversized payload, marking that it was cut. */
export function cap(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

export type PdfBlock =
    | { kind: 'heading'; level: number; text: string }
    | { kind: 'para'; text: string }
    | { kind: 'bullet'; text: string }
    | { kind: 'mono'; text: string }
    | { kind: 'note'; text: string }
    | { kind: 'label'; text: string; color: [number, number, number] }
    | { kind: 'gap' };

/** Strip inline markdown syntax (**bold**, *em*, `code`, [text](url)) for PDF text. */
export function stripInlineMarkdown(text: string): string {
    return text
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

/**
 * Line-based markdown → PDF block classifier: headings sized, emphasis
 * stripped, list markers normalized, fenced code and table rows set in
 * monospace, table separator rows and horizontal rules dropped.
 */
export function mdToPdfBlocks(markdown: string): PdfBlock[] {
    const blocks: PdfBlock[] = [];
    let inFence = false;

    for (const rawLine of markdown.split('\n')) {
        const line = rawLine.replace(/\s+$/, '');

        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            blocks.push({ kind: 'mono', text: rawLine });
            continue;
        }
        if (!line.trim()) {
            blocks.push({ kind: 'gap' });
            continue;
        }

        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            blocks.push({ kind: 'heading', level: heading[1].length, text: stripInlineMarkdown(heading[2]) });
            continue;
        }
        if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
            blocks.push({ kind: 'gap' });
            continue;
        }
        if (/^\s*\|.*\|\s*$/.test(line)) {
            // Drop the |---|---| separator row; keep data rows as monospace so
            // the pipes at least align instead of rendering as broken prose.
            if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
            blocks.push({ kind: 'mono', text: stripInlineMarkdown(line) });
            continue;
        }
        const bullet = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
        if (bullet) {
            const marker = /^\d/.test(bullet[1]) ? `${bullet[1]} ` : '• ';
            blocks.push({ kind: 'bullet', text: `${marker}${stripInlineMarkdown(bullet[2])}` });
            continue;
        }
        blocks.push({ kind: 'para', text: stripInlineMarkdown(line) });
    }

    // Collapse runs of blank lines into a single gap.
    return blocks.filter((b, i, arr) => !(b.kind === 'gap' && arr[i - 1]?.kind === 'gap'));
}

export interface PdfWriter {
    write: (blocks: PdfBlock[]) => void;
    save: (filename: string) => void;
}

export async function createPdfWriter(): Promise<PdfWriter> {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 15;
    const maxWidth = pageWidth - margin * 2;
    let y = margin;

    const ensureRoom = (needed: number) => {
        if (y + needed > pageHeight - margin) {
            doc.addPage();
            y = margin;
        }
    };

    const writeText = (
        text: string,
        opts: { size: number; style?: 'normal' | 'bold' | 'italic'; color?: [number, number, number]; font?: 'helvetica' | 'courier'; indent?: number },
    ) => {
        doc.setFont(opts.font ?? 'helvetica', opts.style ?? 'normal');
        doc.setFontSize(opts.size);
        const [r, g, b] = opts.color ?? [17, 24, 39];
        doc.setTextColor(r, g, b);
        const indent = opts.indent ?? 0;
        const lineHeight = opts.size * 0.45;
        const lines = doc.splitTextToSize(toPdfSafeText(text), maxWidth - indent) as string[];
        for (const line of lines) {
            ensureRoom(lineHeight);
            doc.text(line, margin + indent, y);
            y += lineHeight;
        }
    };

    const HEADING_SIZES: Record<number, number> = { 1: 14, 2: 12.5, 3: 11, 4: 10.5, 5: 10, 6: 10 };

    const write = (blocks: PdfBlock[]) => {
        for (const block of blocks) {
            switch (block.kind) {
                case 'gap':
                    y += 2;
                    break;
                case 'heading':
                    ensureRoom(10);
                    y += block.level <= 2 ? 3 : 2;
                    writeText(block.text, { size: HEADING_SIZES[block.level] ?? 10, style: 'bold' });
                    y += 1;
                    break;
                case 'para':
                    writeText(block.text, { size: 9.5 });
                    break;
                case 'bullet':
                    writeText(block.text, { size: 9.5, indent: 4 });
                    break;
                case 'mono':
                    writeText(block.text, { size: 7.5, font: 'courier', color: [55, 65, 81] });
                    break;
                case 'note':
                    writeText(block.text, { size: 8.5, style: 'italic', color: [107, 114, 128], indent: 2 });
                    break;
                case 'label':
                    ensureRoom(10);
                    y += 2;
                    writeText(block.text, { size: 10.5, style: 'bold', color: block.color });
                    y += 0.5;
                    break;
            }
        }
    };

    return { write, save: (filename: string) => doc.save(filename) };
}

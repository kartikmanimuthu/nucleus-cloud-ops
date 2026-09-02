/**
 * Chat Export Utilities
 *
 * Copy to clipboard (markdown), export to markdown file, and two PDF exports:
 * the full transcript and a "report only" export of the final answer. PDFs are
 * rendered with jsPDF's vector text API (never html2canvas — the old DOM path
 * targeted a container the workspace no longer renders, and one-big-canvas
 * rasterization silently blanks past Chrome's 65,535px cap on long chats) and
 * are markdown-AWARE: headings sized, emphasis markers stripped, lists
 * indented, fences/tables set in monospace — not raw `**`/```/pipe characters.
 */

import { formatDateTime } from './date-utils';
import { unwrapToolInput } from '@/lib/agent-chat/events';
import {
    cap,
    createPdfWriter,
    mdToPdfBlocks,
    PDF_TOOL_IO_CAP,
    stripInlineMarkdown,
    toPdfSafeText,
    type PdfBlock,
} from '@/lib/pdf/pdf-blocks';

// The PDF engine moved to @/lib/pdf/pdf-blocks so Agent Ops renders through the
// SAME block model, writer and WinAnsi rules. Re-exported here because this
// module was its original home and both callers and tests import it from here.
export { mdToPdfBlocks, stripInlineMarkdown, toPdfSafeText, type PdfBlock };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChatMessage = any; // Use any to handle the complex AI SDK message structure

/** Cap long tool payloads in PDFs so a scan-heavy run stays a readable file. */

/**
 * The standard-14 PDF fonts jsPDF draws with (helvetica/courier) use
 * WinAnsiEncoding — one byte per glyph. Anything above it is emitted as raw
 * UTF-16 bytes and drawn as Latin-1: an emoji's D83D DE4F surfaces as "Ø=ÞO",
 * and jsPDF switches that whole string to two-bytes-per-char, which is what
 * spaces the line out ("H a h a"). Both symptoms have one cause, so one filter
 * in writeText fixes both for every block kind and both exports.
 *
 * Embedding a Unicode TTF is the alternative; it costs ~300KB of bundle and
 * still cannot render colour emoji, so decoration is dropped and the glyphs
 * that carry meaning are transliterated.
 */


function isToolPart(part: ChatMessage): boolean {
    return !!(part.toolCallId || (part.type?.startsWith('tool-') && part.type !== 'text') || part.type === 'dynamic-tool');
}

function toolPartName(part: ChatMessage): string {
    return part.toolName || (part.type?.startsWith('tool-') ? part.type.replace('tool-', '') : 'Unknown');
}

/**
 * Extract text content from a message, handling all part types
 */
function extractMessageContent(message: ChatMessage): string {
    const lines: string[] = [];

    // Handle parts array (AI SDK format)
    if (message.parts && Array.isArray(message.parts)) {
        for (const part of message.parts) {
            if (part.type === 'text' && part.text) {
                lines.push(part.text);
            } else if (part.type === 'reasoning' && part.text) {
                lines.push('**Thinking:**');
                lines.push('```');
                lines.push(part.text);
                lines.push('```');
            } else if (isToolPart(part)) {
                // AI SDK v5: tool parts use type "tool-{toolName}" (e.g. "tool-execute_command")
                // with input/output fields instead of the old "tool-invocation" with args/result.
                // unwrapToolInput kills the double-escaped `{ "input": "{\"command\":…}" }`
                // wrapper the executor sometimes produces — same treatment the UI applies.
                const toolName = toolPartName(part);
                const args = unwrapToolInput(part.args ?? part.input);
                const result = part.result || part.output;

                lines.push('');
                lines.push(`**Tool: \`${toolName}\`**`);
                if (args && typeof args === 'object' && Object.keys(args).length > 0) {
                    lines.push('');
                    lines.push('*Input:*');
                    lines.push('```json');
                    lines.push(JSON.stringify(args, null, 2));
                    lines.push('```');
                }
                if (result) {
                    lines.push('');
                    lines.push('*Output:*');
                    lines.push('```');
                    const resultStr = typeof result === 'string'
                        ? result
                        : JSON.stringify(result, null, 2);
                    lines.push(resultStr);
                    lines.push('```');
                }
                lines.push('');
            }
        }
    }

    // Fallback to content string if no parts or parts didn't yield content
    if (lines.length === 0 && message.content) {
        const content = typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content);
        lines.push(content);
    }

    return lines.join('\n');
}

/**
 * Format messages as markdown for clipboard/export
 */
export function formatMessagesAsMarkdown(messages: ChatMessage[], timeZone?: string): string {
    const lines: string[] = [];

    lines.push('# DevOps Agent Conversation');
    lines.push('');
    lines.push(`*Exported on ${formatDateTime(new Date(), 'longDateTime', timeZone)}*`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const message of messages) {
        // Skip tool messages as they are usually rendered as part of assistant messages
        if (message.role === 'tool') {
            continue;
        }

        const sender = message.role === 'user' ? '## 👤 User' : '## 🤖 Agent';
        lines.push(sender);
        lines.push('');

        const content = extractMessageContent(message);
        if (content.trim()) {
            lines.push(content);
            lines.push('');
        }

        lines.push('---');
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Copy formatted chat to clipboard as markdown
 */
export async function copyToClipboard(messages: ChatMessage[]): Promise<boolean> {
    try {
        const markdown = formatMessagesAsMarkdown(messages);
        await navigator.clipboard.writeText(markdown);
        return true;
    } catch (error) {
        console.error('Failed to copy to clipboard:', error);
        return false;
    }
}

/**
 * Export chat to markdown file download
 */
export async function exportToMarkdown(messages: ChatMessage[], threadId: string): Promise<boolean> {
    try {
        const markdown = formatMessagesAsMarkdown(messages);
        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `chat_${threadId}_${Date.now()}.md`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        return true;
    } catch (error) {
        console.error('Failed to export markdown:', error);
        return false;
    }
}

// ─── Markdown-aware PDF rendering ────────────────────────────────────────────


function headerBlocks(title: string, threadId: string): PdfBlock[] {
    return [
        { kind: 'heading', level: 1, text: title },
        { kind: 'note', text: `Thread ${threadId} — exported ${formatDateTime(new Date(), 'longDateTime')}` },
        { kind: 'gap' },
    ];
}

/** Blocks for one message's parts, in stream order. */
function messageBlocks(message: ChatMessage): PdfBlock[] {
    const blocks: PdfBlock[] = [];
    const parts = Array.isArray(message.parts) ? message.parts : [];

    for (const part of parts) {
        if (part.type === 'text' && part.text) {
            blocks.push(...mdToPdfBlocks(part.text));
        } else if (part.type === 'reasoning' && part.text) {
            blocks.push({ kind: 'note', text: `Thinking: ${cap(stripInlineMarkdown(part.text), 1500)}` });
            blocks.push({ kind: 'gap' });
        } else if (isToolPart(part)) {
            const args = unwrapToolInput(part.args ?? part.input);
            const result = part.result || part.output;
            blocks.push({ kind: 'label', text: `Tool: ${toolPartName(part)}`, color: [55, 65, 81] });
            if (args && typeof args === 'object' && Object.keys(args).length > 0) {
                blocks.push({ kind: 'mono', text: cap(JSON.stringify(args, null, 2), 1500) });
            }
            if (result) {
                const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                blocks.push({ kind: 'mono', text: cap(resultStr, PDF_TOOL_IO_CAP) });
            }
            blocks.push({ kind: 'gap' });
        }
    }

    if (blocks.length === 0 && typeof message.content === 'string' && message.content.trim()) {
        blocks.push(...mdToPdfBlocks(message.content));
    }
    return blocks;
}

/**
 * Export the full transcript to a PDF download (markdown-aware, tool payloads
 * capped so scan-heavy runs stay a readable file).
 */
export async function exportToPDF(messages: ChatMessage[], threadId: string): Promise<boolean> {
    try {
        const writer = await createPdfWriter();
        writer.write(headerBlocks('AI Ops conversation', threadId));

        for (const message of messages) {
            if (message.role === 'tool') continue;
            const blocks = messageBlocks(message);
            if (blocks.length === 0) continue;
            writer.write([
                {
                    kind: 'label',
                    text: message.role === 'user' ? 'User' : 'Agent',
                    color: message.role === 'user' ? [29, 78, 216] : [21, 128, 61],
                },
                ...blocks,
                { kind: 'gap' },
            ]);
        }

        writer.save(`chat_${threadId}_${Date.now()}.pdf`);
        return true;
    } catch (error) {
        console.error('Failed to export PDF:', error);
        return false;
    }
}

/**
 * Export ONLY the final deliverable — the last assistant message's answer text
 * — as a rendered PDF, skipping the process log entirely. Returns false when
 * the conversation has no answer text to export.
 */
export async function exportReportToPDF(messages: ChatMessage[], threadId: string): Promise<boolean> {
    try {
        const lastAnswer = [...messages]
            .reverse()
            .find(
                (m) =>
                    m.role === 'assistant' &&
                    Array.isArray(m.parts) &&
                    m.parts.some((p: ChatMessage) => p.type === 'text' && typeof p.text === 'string' && p.text.trim()),
            );
        if (!lastAnswer) return false;

        const reportMd = (lastAnswer.parts as ChatMessage[])
            .filter((p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim())
            .map((p) => p.text as string)
            .join('\n\n');

        const writer = await createPdfWriter();
        writer.write(headerBlocks('AI Ops report', threadId));
        writer.write(mdToPdfBlocks(reportMd));
        writer.save(`report_${threadId}_${Date.now()}.pdf`);
        return true;
    } catch (error) {
        console.error('Failed to export report PDF:', error);
        return false;
    }
}

/**
 * Chat Export Utilities
 * 
 * Provides functionality to copy chat to clipboard and export to markdown
 */

import { formatDateTime } from './date-utils';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChatMessage = any; // Use any to handle the complex AI SDK message structure

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
            } else if (part.toolCallId || (part.type?.startsWith('tool-') && part.type !== 'text') || part.type === 'dynamic-tool') {
                // AI SDK v5: tool parts use type "tool-{toolName}" (e.g. "tool-execute_command")
                // with input/output fields instead of the old "tool-invocation" with args/result
                const toolName = part.toolName || (part.type?.startsWith('tool-') ? part.type.replace('tool-', '') : 'Unknown');
                const args = part.args || part.input;
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
        console.log('[Export] Copying to clipboard, messages count:', messages.length);
        const markdown = formatMessagesAsMarkdown(messages);
        console.log('[Export] Markdown length:', markdown.length);
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
        console.log('[Export] Exporting to markdown, messages count:', messages.length);
        const markdown = formatMessagesAsMarkdown(messages);
        console.log('[Export] Markdown length:', markdown.length);

        // Create a blob with the markdown content
        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });

        // Create download link
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `chat_${threadId}_${Date.now()}.md`;

        // Trigger download
        document.body.appendChild(link);
        link.click();

        // Cleanup
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        return true;
    } catch (error) {
        console.error('Failed to export markdown:', error);
        return false;
    }
}

/**
 * Export chat to a PDF download.
 *
 * Renders the messages directly with jsPDF's vector text API (same approach as
 * lib/agent-ops/export-pdf.ts) — NOT html2canvas: the old DOM-capture path
 * targeted a container id the workspace no longer renders, and one-big-canvas
 * rasterization silently blanks past Chrome's 65,535px canvas cap on long
 * chats. Vector text has neither problem and stays selectable/searchable.
 */
export async function exportToPDF(messages: ChatMessage[], threadId: string): Promise<boolean> {
    try {
        console.log('[Export] Exporting to PDF, messages count:', messages.length);
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

        const writeLines = (
            text: string,
            opts: { size: number; style?: 'normal' | 'bold'; color?: [number, number, number]; font?: 'helvetica' | 'courier' },
        ) => {
            doc.setFont(opts.font ?? 'helvetica', opts.style ?? 'normal');
            doc.setFontSize(opts.size);
            const [r, g, b] = opts.color ?? [17, 24, 39];
            doc.setTextColor(r, g, b);
            const lineHeight = opts.size * 0.45;
            const lines = doc.splitTextToSize(text, maxWidth) as string[];
            for (const line of lines) {
                ensureRoom(lineHeight);
                doc.text(line, margin, y);
                y += lineHeight;
            }
        };

        writeLines('AI Ops conversation', { size: 16, style: 'bold' });
        y += 2;
        writeLines(`Thread ${threadId} — exported ${formatDateTime(new Date(), 'longDateTime')}`, {
            size: 9,
            color: [107, 114, 128],
        });
        y += 5;

        for (const message of messages) {
            // Tool messages are folded into the assistant content extraction.
            if (message.role === 'tool') continue;
            const content = extractMessageContent(message);
            if (!content.trim()) continue;

            ensureRoom(12);
            y += 2;
            writeLines(message.role === 'user' ? 'User' : 'Agent', {
                size: 11,
                style: 'bold',
                color: message.role === 'user' ? [29, 78, 216] : [21, 128, 61],
            });
            y += 1;
            writeLines(content, { size: 9.5 });
            y += 3;
        }

        doc.save(`chat_${threadId}_${Date.now()}.pdf`);
        return true;
    } catch (error) {
        console.error('Failed to export PDF:', error);
        return false;
    }
}

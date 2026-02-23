/**
 * Chat Export Utilities
 * 
 * Provides functionality to copy chat to clipboard and export to markdown
 */

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
                // Include reasoning/thinking content
                lines.push('**Thinking:**');
                lines.push('```');
                lines.push(part.text);
                lines.push('```');
            } else if (part.type === 'tool-invocation') {
                lines.push('');
                lines.push(`**Tool: \`${part.toolName || 'Unknown'}\`**`);
                if (part.args && Object.keys(part.args).length > 0) {
                    lines.push('');
                    lines.push('*Input:*');
                    lines.push('```json');
                    lines.push(JSON.stringify(part.args, null, 2));
                    lines.push('```');
                }
                if (part.result) {
                    lines.push('');
                    lines.push('*Output:*');
                    lines.push('```');
                    // Handle result - could be string or object
                    const resultStr = typeof part.result === 'string'
                        ? part.result
                        : JSON.stringify(part.result, null, 2);
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
export function formatMessagesAsMarkdown(messages: ChatMessage[]): string {
    const lines: string[] = [];

    lines.push('# DevOps Agent Conversation');
    lines.push('');
    lines.push(`*Exported on ${new Date().toLocaleString()}*`);
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

// Keep the old function name for backwards compatibility
export async function exportToPDF(messages: ChatMessage[], threadId: string): Promise<boolean> {
    try {
        console.log('[Export] Exporting to PDF, messages count:', messages.length);

        // Dynamically import html2pdf to avoid SSR issues
        const html2pdf = (await import('html2pdf.js')).default;

        const element = document.getElementById('chat-messages-container');
        if (!element) {
            console.error('Chat messages container not found');
            return false;
        }

        const opt = {
            margin: 10,
            filename: `chat_${threadId}_${Date.now()}.pdf`,
            image: { type: 'jpeg' as const, quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'mm' as const, format: 'a4' as const, orientation: 'portrait' as const }
        };

        // Add a temporary class to ensure consistent styling during export if needed
        element.classList.add('pdf-export-mode');

        await html2pdf().set(opt).from(element).save();

        // Remove the temporary class
        element.classList.remove('pdf-export-mode');

        return true;
    } catch (error) {
        console.error('Failed to export PDF:', error);
        return false;
    }
}

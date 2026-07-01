/**
 * build-chat-transcript.ts
 *
 * Pure function that flattens chat messages (text + tool-invocation parts) into
 * a single transcript string for skill distillation. Text is never truncated;
 * only oversized individual tool *results* are capped (args and all prose are
 * kept in full — see docs/superpowers/specs/2026-07-01-skill-distillation-redesign-design.md).
 */

/** Cap for a single tool result payload, in characters. Never applied to args or chat text. */
export const TOOL_RESULT_CHAR_CAP = 4000;

export interface ChatMessagePart {
    type: string;
    text?: string;
    toolName?: string;
    name?: string;
    toolCallId?: string;
    args?: unknown;
    input?: unknown;
    result?: unknown;
    output?: unknown;
}

export interface ChatMessageLike {
    role: string;
    parts?: ChatMessagePart[];
    content?: unknown;
}

function isToolPart(part: ChatMessagePart): boolean {
    return part.type === 'tool-invocation' || Boolean(part.toolCallId);
}

function stringifyValue(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function serializeToolPart(part: ChatMessagePart): string {
    let toolName = part.toolName || part.name;
    if (!toolName && part.type?.startsWith('tool-')) {
        toolName = part.type.replace('tool-', '').replace(/_/g, ' ');
    }
    toolName = toolName || 'tool';

    const args = part.args || part.input;
    const result = part.result || part.output;

    const argsStr = args === undefined ? '' : stringifyValue(args);
    let block = `TOOL_CALL: ${toolName}(${argsStr})`;

    if (result !== undefined) {
        let resultStr = stringifyValue(result);
        if (resultStr.length > TOOL_RESULT_CHAR_CAP) {
            const truncatedCount = resultStr.length - TOOL_RESULT_CHAR_CAP;
            resultStr = `${resultStr.slice(0, TOOL_RESULT_CHAR_CAP)}  [...truncated ${truncatedCount} more chars]`;
        }
        block += `\nTOOL_RESULT: ${resultStr}`;
    }

    return block;
}

/** Flattens messages into "ROLE: body" blocks joined by blank lines, preserving part order. */
export function buildChatTranscript(messages: ChatMessageLike[]): string {
    return messages
        .map((m) => {
            const segments: string[] = [];
            for (const part of m.parts ?? []) {
                if (part.type === 'text') {
                    if (part.text && part.text.trim().length > 0) {
                        segments.push(part.text);
                    }
                } else if (isToolPart(part)) {
                    segments.push(serializeToolPart(part));
                }
            }
            const body =
                segments.length > 0 ? segments.join('\n') : typeof m.content === 'string' ? m.content : '';
            return `${m.role.toUpperCase()}: ${body}`;
        })
        .join('\n\n');
}

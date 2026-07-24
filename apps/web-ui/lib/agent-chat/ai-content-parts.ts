// Reconstructs UI parts from a persisted content-block array (Anthropic/Bedrock shapes); without this, history renders raw JSON.
type AiContentPart = { type: 'reasoning' | 'text'; text: string };

function normalizeToBlockArray(raw: unknown): unknown[] | null {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        if (!raw.trimStart().startsWith('[')) return null;
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}

function isReasoningBlock(b: Record<string, unknown>): boolean {
    if ('reasoningContent' in b || 'reasoning_content' in b) return true;
    const t = b.type;
    return t === 'reasoning' || t === 'thinking' || t === 'reasoning_content'
        || t === 'redacted_reasoning' || t === 'redacted_thinking';
}

function extractReasoningText(b: Record<string, unknown>): string {
    if (typeof b.reasoning === 'string') return b.reasoning;
    if (typeof b.thinking === 'string') return b.thinking;
    const rc = b.reasoningContent as { reasoningText?: { text?: unknown } } | undefined;
    if (rc?.reasoningText && typeof rc.reasoningText.text === 'string') return rc.reasoningText.text;
    return '';
}

// null = not a content-block array (caller keeps the string/marker path); otherwise reconstructed parts (possibly empty).
export function reconstructAiContentParts(rawContent: unknown): AiContentPart[] | null {
    const blocks = normalizeToBlockArray(rawContent);
    if (blocks === null) return null;

    const parts: AiContentPart[] = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
            if (b.text.trim().length > 0) parts.push({ type: 'text', text: b.text });
            continue;
        }
        if (isReasoningBlock(b)) {
            const text = extractReasoningText(b);
            if (text.trim().length > 0) parts.push({ type: 'reasoning', text });
        }
        // tool_use / image / unknown → skipped (tool calls come from metadata.tool_calls)
    }
    return parts;
}

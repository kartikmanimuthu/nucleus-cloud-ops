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

    // Consecutive blocks of the same kind are ONE part. A reasoning model keeps every
    // streamed delta as its own block — 644 of them for a single report in the run this
    // was written from — and one part per block renders as one UI row per block, which
    // shatters the answer into hundreds of fragments. Whitespace is judged per RUN, not
    // per block: Bedrock splits mid-word and emits bare-space deltas between the halves,
    // so dropping those individually fuses words ("no" + " " + "blocking").
    const parts: AiContentPart[] = [];
    let buf = '';
    let bufKind: AiContentPart['type'] | null = null;

    const flush = () => {
        if (bufKind && buf.trim().length > 0) parts.push({ type: bufKind, text: buf.trim() });
        buf = '';
        bufKind = null;
    };
    const append = (kind: AiContentPart['type'], text: string) => {
        if (kind !== bufKind) flush();
        bufKind = kind;
        buf += text;
    };

    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
            append('text', b.text);
            continue;
        }
        if (isReasoningBlock(b)) {
            append('reasoning', extractReasoningText(b));
        }
        // tool_use / image / unknown → skipped (tool calls come from metadata.tool_calls)
    }
    flush();
    return parts;
}

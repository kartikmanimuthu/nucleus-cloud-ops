/**
 * Helpers for parsing structured JSON out of raw LLM responses.
 *
 * Model replies are messy: `content` may be a plain string OR an array of
 * provider content blocks (text blocks, thinking/reasoning blocks, …), and the
 * JSON payload is routinely wrapped in ```json fences or framed by prose
 * ("Here is the JSON: …"). Call sites that did a bare JSON.parse over the raw
 * value returned 502 "Model did not return valid JSON" whenever any of that
 * framing was present — these helpers absorb it.
 */

/**
 * Flatten a LangChain/provider message `content` into plain text. Only text
 * carries over: string blocks and `{ type?: 'text', text: string }` blocks.
 * Thinking/reasoning blocks (no plain `text`, or a non-text `type`) are
 * dropped — they are model narration, not the payload.
 */
export function contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((block) => {
                if (typeof block === 'string') return block;
                if (block && typeof block === 'object') {
                    const b = block as Record<string, unknown>;
                    if ((b.type === 'text' || b.type === undefined) && typeof b.text === 'string') {
                        return b.text;
                    }
                }
                return '';
            })
            .join('');
    }
    return content == null ? '' : JSON.stringify(content);
}

function parseObject(candidate: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // fall through
    }
    return null;
}

/**
 * Extract the first JSON *object* from a raw model reply: strips markdown
 * fences anywhere, tries the whole string, then falls back to the outermost
 * `{` … `}` span (tolerating leading/trailing prose). Returns null when no
 * object parses — callers decide how to fail.
 */
export function extractJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(
    raw: string,
): T | null {
    const cleaned = raw.replace(/```(?:json)?/gi, '').trim();

    const whole = parseObject(cleaned);
    if (whole) return whole as T;

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
        const span = parseObject(cleaned.slice(start, end + 1));
        if (span) return span as T;
    }
    return null;
}

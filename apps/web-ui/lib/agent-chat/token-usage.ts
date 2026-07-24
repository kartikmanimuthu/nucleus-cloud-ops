export interface TokenUsage { input: number; output: number }

// Accepts the LangChain shape (input_tokens/output_tokens) or the data-usage shape (input/output).
export function parseUsageMetadata(meta: unknown): TokenUsage | null {
    if (!meta || typeof meta !== 'object') return null;
    const m = meta as Record<string, unknown>;
    const input = Number(m.input_tokens ?? m.input) || 0;
    const output = Number(m.output_tokens ?? m.output) || 0;
    if (!input && !output) return null;
    return { input, output };
}

// <1000 -> integer; >=1000 -> one-decimal "k"; >=1e6 -> "m".
export function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n < 1000) return String(Math.round(n));
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}m`;
}

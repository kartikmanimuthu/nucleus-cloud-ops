import { describe, it, expect } from 'vitest';
import { parseUsageMetadata, formatTokens } from '../token-usage';

describe('parseUsageMetadata', () => {
    it('reads the LangChain input_tokens/output_tokens shape', () => {
        expect(parseUsageMetadata({ input_tokens: 3, output_tokens: 4 })).toEqual({ input: 3, output: 4 });
    });
    it('reads the {input,output} data-part shape', () => {
        expect(parseUsageMetadata({ input: 5, output: 6 })).toEqual({ input: 5, output: 6 });
    });
    it('returns null when both are zero/absent, or meta is not an object', () => {
        expect(parseUsageMetadata({ input_tokens: 0, output_tokens: 0 })).toBeNull();
        expect(parseUsageMetadata({})).toBeNull();
        expect(parseUsageMetadata(null)).toBeNull();
        expect(parseUsageMetadata('x')).toBeNull();
    });
    it('keeps a positive side even if the other is missing', () => {
        expect(parseUsageMetadata({ output_tokens: 9 })).toEqual({ input: 0, output: 9 });
    });
});

describe('formatTokens', () => {
    it('formats by magnitude', () => {
        expect(formatTokens(0)).toBe('0');
        expect(formatTokens(999)).toBe('999');
        expect(formatTokens(1000)).toBe('1.0k');
        expect(formatTokens(48200)).toBe('48.2k');
        expect(formatTokens(1_500_000)).toBe('1.5m');
    });
});

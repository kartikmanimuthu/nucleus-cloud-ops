import { describe, it, expect } from 'vitest';
import { isToolResultError, truncateForReview } from '@/lib/agent/agent-shared';

describe('isToolResultError', () => {
    it('does NOT flag successful output that merely mentions errors (CloudWatch "Errors" metric)', () => {
        expect(isToolResultError(undefined, '{"Label": "Errors", "Datapoints": []}')).toBe(false);
    });

    it('does NOT flag plain text mentioning error rates', () => {
        expect(isToolResultError(undefined, 'CloudWatch shows normal error rates and no exceptions were thrown.')).toBe(false);
    });

    it('flags execute_command failures via the "Command failed:" prefix', () => {
        expect(isToolResultError(undefined, 'Command failed: aws: command not found\n')).toBe(true);
    });

    it('flags ToolMessage.status === "error" regardless of content', () => {
        expect(isToolResultError('error', 'all good here')).toBe(true);
    });

    it('treats status "success" as non-error for benign content', () => {
        expect(isToolResultError('success', 'Successfully written to file.txt')).toBe(false);
    });

    it('flags JSON tool results with top-level success:false (get_aws_credentials contract)', () => {
        expect(isToolResultError(undefined, '{"success":false,"error":"Account not found"}')).toBe(true);
    });

    it('does NOT flag JSON with success:true', () => {
        expect(isToolResultError(undefined, '{"success":true,"profileName":"tenant-123"}')).toBe(false);
    });

    it('flags "Error:"-prefixed tool contract strings (jail, file tools, ToolNode wrapper)', () => {
        expect(isToolResultError(undefined, 'Error: path "/etc/passwd" is outside the agent working directory')).toBe(true);
        expect(isToolResultError(undefined, 'Error reading file: ENOENT: no such file or directory')).toBe(true);
    });

    it('flags glob/grep/web_search error prefixes', () => {
        expect(isToolResultError(undefined, 'Glob error: something broke')).toBe(true);
        expect(isToolResultError(undefined, 'Grep error: something broke')).toBe(true);
        expect(isToolResultError(undefined, 'Web search error: Tavily API error: 500')).toBe(true);
    });

    it('tolerates leading whitespace before an error prefix', () => {
        expect(isToolResultError(undefined, '  Command failed: timeout')).toBe(true);
    });

    it('does not throw on malformed/truncated JSON and treats it as non-error', () => {
        expect(isToolResultError(undefined, '{"Label": "Errors", "Datapoints": [')).toBe(false);
    });

    it('handles empty content', () => {
        expect(isToolResultError(undefined, '')).toBe(false);
        expect(isToolResultError('error', '')).toBe(true);
    });
});

describe('truncateForReview', () => {
    it('returns short text unchanged (no marker)', () => {
        const text = 'A complete short report.';
        expect(truncateForReview(text, 4000)).toBe(text);
        expect(truncateForReview(text, 4000)).not.toContain('TRUNCATED FOR REVIEW ONLY');
    });

    it('returns text exactly at the limit unchanged', () => {
        const text = 'x'.repeat(4000);
        expect(truncateForReview(text, 4000)).toBe(text);
    });

    it('appends the review-only marker with the original length when it truncates', () => {
        const text = 'y'.repeat(4500);
        const result = truncateForReview(text, 4000);
        expect(result).toContain('TRUNCATED FOR REVIEW ONLY');
        expect(result).toContain('4500 characters');
        expect(result).toContain('do NOT treat this cutoff as an incomplete or truncated deliverable');
    });

    it('places the marker AFTER the maxChars slice (kept text is exactly the slice)', () => {
        const text = 'z'.repeat(5000);
        const result = truncateForReview(text, 4000);
        expect(result.startsWith('z'.repeat(4000) + '\n…[TRUNCATED FOR REVIEW ONLY')).toBe(true);
        // Bounded: slice + one marker line, nothing unbounded.
        expect(result.length).toBeLessThan(4000 + 250);
    });

    it('handles empty input', () => {
        expect(truncateForReview('', 100)).toBe('');
    });
});

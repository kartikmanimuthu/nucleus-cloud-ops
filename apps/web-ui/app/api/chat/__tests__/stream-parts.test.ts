import { describe, it, expect } from 'vitest';
import { buildMemoryPart, humanizeReflection } from '@/app/api/chat/stream-parts';

describe('buildMemoryPart', () => {
    it('counts markdown bullets (-) and returns them as `count`', () => {
        const summary = '- recalled fact one\n- recalled fact two\n- recalled fact three';
        const part = buildMemoryPart('recall', summary);
        expect(part.type).toBe('data-memory');
        expect(part.data).toEqual({ op: 'recall', summary, count: 3 });
    });

    it('counts `•` bullets', () => {
        const summary = '• fact one\n• fact two';
        const part = buildMemoryPart('save', summary);
        expect((part.data as any).count).toBe(2);
    });

    it('counts mixed -, *, • bullet markers', () => {
        const summary = '- fact one\n* fact two\n• fact three';
        const part = buildMemoryPart('recall', summary);
        expect((part.data as any).count).toBe(3);
    });

    it('returns count: null for prose with no bullets', () => {
        const summary = 'Recalled a general preference about deployment timing.';
        const part = buildMemoryPart('recall', summary);
        expect((part.data as any).count).toBeNull();
    });

    it('sets op to the passed value', () => {
        expect((buildMemoryPart('save', 'no bullets here').data as any).op).toBe('save');
        expect((buildMemoryPart('recall', 'no bullets here').data as any).op).toBe('recall');
    });
});

describe('humanizeReflection', () => {
    it('turns full reflector JSON into prose with no braces or quotes', () => {
        const raw = JSON.stringify({
            isComplete: false,
            analysis: 'The plan correctly lists AWS accounts before filtering.',
            issues: 'Missing region filter in step 2.',
            suggestions: 'Add a region parameter before executing.',
            updatedPlan: [],
        });
        const result = humanizeReflection(raw);
        expect(result).toBe(
            'The plan correctly lists AWS accounts before filtering.\n\nIssues: Missing region filter in step 2.\n\nNext: Add a region parameter before executing.'
        );
        expect(result).not.toMatch(/[{}]/);
        expect(result).not.toContain('"analysis"');
    });

    it('parses JSON wrapped in ```json fences', () => {
        const payload = JSON.stringify({
            isComplete: true,
            analysis: 'All steps completed successfully.',
            issues: '',
            suggestions: '',
        });
        const raw = '```json\n' + payload + '\n```';
        expect(humanizeReflection(raw)).toBe('All steps completed successfully.');
    });

    it('omits the Issues line when issues is "None for this step."', () => {
        const raw = JSON.stringify({
            isComplete: false,
            analysis: 'Step complete, nothing outstanding.',
            issues: 'None for this step.',
            suggestions: 'Continue to the next step.',
        });
        expect(humanizeReflection(raw)).toBe(
            'Step complete, nothing outstanding.\n\nNext: Continue to the next step.'
        );
    });

    it('returns raw text unchanged when JSON parsing fails', () => {
        const raw = 'This is not JSON at all, just plain reflector prose.';
        expect(humanizeReflection(raw)).toBe(raw);
    });

    it('returns raw text unchanged for JSON with an unclosed brace', () => {
        const raw = '{ "analysis": "incomplete';
        expect(humanizeReflection(raw)).toBe(raw);
    });

    it('parses JSON preceded by leading prose', () => {
        const payload = JSON.stringify({
            isComplete: false,
            analysis: 'Reviewed the plan against the goal.',
            issues: '',
            suggestions: 'Proceed to the next step.',
        });
        const raw = 'Here is my reflection:\n' + payload;
        expect(humanizeReflection(raw)).toBe(
            'Reviewed the plan against the goal.\n\nNext: Proceed to the next step.'
        );
    });

    it('omits the Next line when suggestions is missing', () => {
        const raw = JSON.stringify({
            isComplete: true,
            analysis: 'Everything checks out.',
        });
        expect(humanizeReflection(raw)).toBe('Everything checks out.');
    });

    it('keeps suggestions when the value is exactly "None" (asymmetric with the Issues omission rule)', () => {
        const raw = JSON.stringify({
            isComplete: false,
            analysis: 'Step in progress.',
            issues: '',
            suggestions: 'None',
        });
        expect(humanizeReflection(raw)).toBe('Step in progress.\n\nNext: None');
    });

    it('returns raw unchanged when a {...} span exists but has none of the reflector keys (guards against hijack by an unrelated embedded object)', () => {
        const raw = 'Some notes before an unrelated object: {"foo": "bar", "count": 3} and after.';
        expect(humanizeReflection(raw)).toBe(raw);
    });

    // reflectNode (apps/web-ui/lib/agent/planning-agent.ts) persists a pre-formatted
    // feedback string, never raw JSON — persisted reflection content must reach the
    // SAME prose shape the live JSON path produces. Mirrors planning-agent's exact
    // feedback template so the parsing is derived from the real format, not guessed.
    function buildReflectNodeFeedback(analysis: string, issues: string, suggestions: string, isComplete: boolean): string {
        return `🔍 **Reflection Analysis:**
${analysis}

${issues !== 'None' ? `⚠️ **Issues Found:** ${issues}` : ''}
${suggestions !== 'None' ? `💡 **Suggestions:** ${suggestions}` : ''}

**Task Complete:** ${isComplete ? '✅ Yes' : '❌ No, continuing...'}`;
    }

    it('converts the reflectNode feedback format (full sections) to the same prose shape as the JSON path', () => {
        const raw = buildReflectNodeFeedback(
            'The plan correctly lists AWS accounts before filtering.',
            'Missing region filter in step 2.',
            'Add a region parameter before executing.',
            false,
        );
        expect(humanizeReflection(raw)).toBe(
            'The plan correctly lists AWS accounts before filtering.\n\nIssues: Missing region filter in step 2.\n\nNext: Add a region parameter before executing.'
        );
    });

    it('omits the Issues line when the feedback format has no Issues section (reflector reported "None")', () => {
        const raw = buildReflectNodeFeedback('All good so far.', 'None', 'Keep going.', false);
        expect(humanizeReflection(raw)).toBe('All good so far.\n\nNext: Keep going.');
    });

    it('drops the Task Complete trailer from the feedback format entirely', () => {
        const raw = buildReflectNodeFeedback('Nothing left to do.', 'None', 'None', true);
        expect(humanizeReflection(raw)).toBe('Nothing left to do.');
    });
});

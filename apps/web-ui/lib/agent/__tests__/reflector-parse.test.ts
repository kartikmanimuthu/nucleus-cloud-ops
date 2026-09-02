/**
 * Unit tests for the planning-agent reflector's pure parsing/decision helpers:
 * - parseReflectorResponse: JSON extraction, truncation tolerance, updatedPlan mapping
 * - mapUpdatedPlanEntries:  index-based (current) + step-text (legacy) plan formats
 * - applyStallBreaker:      forces completion after 2 consecutive no-op revisions
 *
 * These were extracted from reflectNode specifically so the fixes below (reflector
 * voting isComplete:true but the signal getting lost to truncation, or the loop
 * ping-ponging reflect<->revise with no new evidence) are testable without spinning
 * up the full LangGraph.
 */

import { describe, it, expect } from 'vitest';
import {
    parseReflectorResponse,
    mapUpdatedPlanEntries,
    applyStallBreaker,
} from '../planning-agent';
import type { PlanStep } from '../agent-shared';

const plan = (steps: Array<[string, PlanStep['status']]>): PlanStep[] =>
    steps.map(([step, status]) => ({ step, status }));

describe('parseReflectorResponse', () => {
    it('parses a well-formed JSON object with index-based updatedPlan', () => {
        const p = plan([['Call list_aws_accounts', 'completed'], ['Get credentials', 'in_progress']]);
        const content = JSON.stringify({
            isComplete: false,
            analysis: 'Step 1 done, step 2 in progress',
            issues: 'None',
            suggestions: 'None',
            updatedPlan: [{ index: 1, status: 'completed' }, { index: 2, status: 'completed' }],
        });

        const result = parseReflectorResponse(content, p);

        expect(result.isComplete).toBe(false);
        expect(result.analysis).toBe('Step 1 done, step 2 in progress');
        expect(result.updatedPlan).toEqual([
            { step: 'Call list_aws_accounts', status: 'completed' },
            { step: 'Get credentials', status: 'completed' },
        ]);
    });

    it('treats truncated JSON containing a literal isComplete:true as complete (Fix 2)', () => {
        // Simulates a maxTokens cutoff mid-object: no closing brace, but isComplete
        // was already emitted before the cut. The balanced-brace scan can't find a
        // matching '}', so this must fall through to the raw-content regex fallback.
        const truncated = '{"isComplete": true, "analysis": "All steps verified and the report was rendered for the us';

        const result = parseReflectorResponse(truncated, []);

        expect(result.isComplete).toBe(true);
        expect(result.analysis).toContain('truncated but isComplete detected');
    });

    it('still completes on truncated JSON with single-quoted isComplete key variant', () => {
        const truncated = "{'isComplete':true, 'analysis': 'done but cut off here and there is more tex";
        const result = parseReflectorResponse(truncated, []);
        expect(result.isComplete).toBe(true);
    });

    it('does not falsely complete when no isComplete signal is present at all', () => {
        const truncated = '{"analysis": "still working through pagination, nothing conclusive yet and the text keeps going';
        const result = parseReflectorResponse(truncated, []);
        expect(result.isComplete).toBe(false);
    });

    it('maps old-format (step-text) updatedPlan entries onto the existing plan (Fix 1 backward-compat)', () => {
        const p = plan([['Describe EC2 instances', 'in_progress'], ['Render report', 'pending']]);
        const content = JSON.stringify({
            isComplete: false,
            analysis: 'partial',
            updatedPlan: [
                { step: 'Describe EC2 instances', status: 'completed' },
                { step: 'Render report', status: 'in_progress' },
            ],
        });

        const result = parseReflectorResponse(content, p);

        expect(result.updatedPlan).toEqual([
            { step: 'Describe EC2 instances', status: 'completed' },
            { step: 'Render report', status: 'in_progress' },
        ]);
    });

    it('ignores malformed updatedPlan entries without throwing (Fix 1)', () => {
        const p = plan([['Step A', 'pending'], ['Step B', 'pending']]);
        const content = JSON.stringify({
            isComplete: false,
            analysis: 'x',
            updatedPlan: [
                { status: 'bogus-status' },           // invalid status
                { index: 99, status: 'completed' },   // out-of-range index
                { step: 'Nonexistent step', status: 'completed' }, // no match
                null,
                'not-an-object',
            ],
        });

        expect(() => parseReflectorResponse(content, p)).not.toThrow();
        const result = parseReflectorResponse(content, p);
        // Nothing valid to apply -> updatedPlan is empty, caller keeps the existing plan.
        expect(result.updatedPlan).toEqual([]);
    });

    it('applies only the valid entries in a mixed-quality updatedPlan array', () => {
        const p = plan([['Step A', 'pending'], ['Step B', 'pending'], ['Step C', 'pending']]);
        const content = JSON.stringify({
            isComplete: false,
            analysis: 'x',
            updatedPlan: [
                { index: 1, status: 'completed' },
                { status: 'bogus' },
                { index: 3, status: 'failed' },
            ],
        });

        const result = parseReflectorResponse(content, p);

        expect(result.updatedPlan).toEqual([
            { step: 'Step A', status: 'completed' },
            { step: 'Step B', status: 'pending' }, // untouched — malformed entry skipped
            { step: 'Step C', status: 'failed' },
        ]);
    });

    it('falls back to the legacy "task complete" phrase detector when there is no JSON at all', () => {
        const result = parseReflectorResponse('The task has been successfully completed with no errors.', []);
        expect(result.isComplete).toBe(true);
    });

    it('handles JSON.parse failure with the isComplete regex fallback', () => {
        // Balanced but invalid JSON (trailing comma) — matches the brace scan, fails JSON.parse.
        const malformed = '{"isComplete": true, "analysis": "done",}';
        const result = parseReflectorResponse(malformed, []);
        expect(result.isComplete).toBe(true);
        expect(result.analysis).toContain('JSON parse failed but isComplete detected');
    });

    it('stays incomplete when JSON.parse fails and no isComplete:true literal is present', () => {
        const malformed = '{"isComplete": false, "analysis": "still working",}';
        const result = parseReflectorResponse(malformed, []);
        expect(result.isComplete).toBe(false);
        expect(result.analysis).toBe('Reflection JSON parse failed. Continuing.');
    });

    it('reports parseFailed and a safe fallback when the parser itself throws outright', () => {
        // content is typed as string, but a defensive outer catch guards against a
        // non-string slipping through at runtime (e.g. an unexpected model response shape).
        const result = parseReflectorResponse(undefined as any, []);
        expect(result.isComplete).toBe(false);
        expect(result.parseFailed).toBe(true);
        expect(result.analysis).toContain('Reflection parsing failed');
    });
});

describe('mapUpdatedPlanEntries', () => {
    it('maps by 1-based index onto the plan array, preserving step text', () => {
        const p = plan([['Step 1', 'pending'], ['Step 2', 'pending'], ['Step 3', 'pending']]);
        const result = mapUpdatedPlanEntries(
            [{ index: 1, status: 'completed' }, { index: 3, status: 'failed' }],
            p,
        );
        expect(result).toEqual([
            { step: 'Step 1', status: 'completed' },
            { step: 'Step 2', status: 'pending' },
            { step: 'Step 3', status: 'failed' },
        ]);
    });

    it('returns [] when entries is empty or plan is empty', () => {
        expect(mapUpdatedPlanEntries([], plan([['A', 'pending']]))).toEqual([]);
        expect(mapUpdatedPlanEntries([{ index: 1, status: 'completed' }], [])).toEqual([]);
    });

    it('ignores an out-of-range index without throwing', () => {
        const p = plan([['Only step', 'pending']]);
        expect(() => mapUpdatedPlanEntries([{ index: 5, status: 'completed' }], p)).not.toThrow();
        expect(mapUpdatedPlanEntries([{ index: 5, status: 'completed' }], p)).toEqual([]);
    });
});

describe('applyStallBreaker', () => {
    const baseParsed = (isComplete: boolean) => ({
        analysis: 'still going',
        issues: 'None',
        suggestions: 'None',
        isComplete,
        updatedPlan: [],
    });

    it('leaves the result untouched when already complete', () => {
        const parsed = baseParsed(true);
        expect(applyStallBreaker(parsed, 5)).toEqual(parsed);
    });

    it('leaves the result untouched below the stall threshold', () => {
        const parsed = baseParsed(false);
        expect(applyStallBreaker(parsed, 0)).toEqual(parsed);
        expect(applyStallBreaker(parsed, 1)).toEqual(parsed);
    });

    it('forces isComplete=true after 2 consecutive no-op revisions', () => {
        const parsed = baseParsed(false);
        const result = applyStallBreaker(parsed, 2);
        expect(result.isComplete).toBe(true);
        expect(result.analysis).toContain('Auto-completed');
    });

    it('still forces completion for stall counts beyond the threshold', () => {
        const parsed = baseParsed(false);
        expect(applyStallBreaker(parsed, 5).isComplete).toBe(true);
    });
});

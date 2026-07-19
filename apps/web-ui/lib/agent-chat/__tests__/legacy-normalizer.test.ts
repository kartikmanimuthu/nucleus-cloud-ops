import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { normalizeLegacyContent } from '../legacy-normalizer';

describe('normalizeLegacyContent — marker mapping', () => {
    it('maps PLANNING_PHASE_START to phase planning', () => {
        expect(normalizeLegacyContent('PLANNING_PHASE_START\nHere is the plan.')).toEqual({
            phase: 'planning',
            text: 'Here is the plan.',
        });
    });

    it('maps EXECUTION_PHASE_START to phase execution', () => {
        expect(normalizeLegacyContent('EXECUTION_PHASE_START\nRunning tools.')).toEqual({
            phase: 'execution',
            text: 'Running tools.',
        });
    });

    it('maps REFLECTION_PHASE_START to phase reflection', () => {
        expect(normalizeLegacyContent('REFLECTION_PHASE_START\nChecking work.')).toEqual({
            phase: 'reflection',
            text: 'Checking work.',
        });
    });

    it('maps REVISION_PHASE_START to phase revision', () => {
        expect(normalizeLegacyContent('REVISION_PHASE_START\nFixing it.')).toEqual({
            phase: 'revision',
            text: 'Fixing it.',
        });
    });

    it('maps FINAL_PHASE_START to phase final', () => {
        expect(normalizeLegacyContent('FINAL_PHASE_START\nDone.')).toEqual({
            phase: 'final',
            text: 'Done.',
        });
    });

    it('maps MEMORY_RECALL_PHASE_START to phase memory_recall', () => {
        expect(normalizeLegacyContent('MEMORY_RECALL_PHASE_START\nRecalling context.')).toEqual({
            phase: 'memory_recall',
            text: 'Recalling context.',
        });
    });

    it('maps MEMORY_SAVE_PHASE_START to phase memory_save', () => {
        expect(normalizeLegacyContent('MEMORY_SAVE_PHASE_START\nSaving a memory.')).toEqual({
            phase: 'memory_save',
            text: 'Saving a memory.',
        });
    });

    it('unmarked content passes through as phase text', () => {
        expect(normalizeLegacyContent('Just a plain answer.')).toEqual({
            phase: 'text',
            text: 'Just a plain answer.',
        });
    });

    it('empty string passes through as phase text', () => {
        expect(normalizeLegacyContent('')).toEqual({ phase: 'text', text: '' });
    });
});

describe('normalizeLegacyContent — property tests', () => {
    const MARKERS = [
        'PLANNING_PHASE_START\n',
        'EXECUTION_PHASE_START\n',
        'REFLECTION_PHASE_START\n',
        'REVISION_PHASE_START\n',
        'FINAL_PHASE_START\n',
        'MEMORY_RECALL_PHASE_START\n',
        'MEMORY_SAVE_PHASE_START\n',
    ];

    it('for any string without a leading marker, text passes through unchanged', () => {
        fc.assert(
            fc.property(fc.string(), (s) => {
                fc.pre(!MARKERS.some((m) => s.startsWith(m)));
                const { text } = normalizeLegacyContent(s);
                expect(text).toBe(s);
            }),
        );
    });

    it('for any marker + string, the marker is stripped and text matches the suffix', () => {
        fc.assert(
            fc.property(fc.constantFrom(...MARKERS), fc.string(), (marker, s) => {
                const { text } = normalizeLegacyContent(marker + s);
                expect(text).toBe(s);
            }),
        );
    });
});

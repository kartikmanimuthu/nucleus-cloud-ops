import { describe, it, expect } from 'vitest';
import { createChecklist, addStep, completeStep, renderChecklist } from './checklist';

/** Steps carry an in-flight and a finished form; `done` defaults to `active` where
 *  a test only cares about ordering, not tense. */
const p = (active: string, done = active) => ({ active, done });

describe('checklist', () => {
    it('renders a placeholder before any step exists', () => {
        expect(renderChecklist(createChecklist())).toBe('Getting started...');
    });

    it('switches from the active to the finished phrase when a step completes', () => {
        let state = createChecklist();
        state = addStep(state, p('Reading a file...', 'Read a file'), { key: 'read_file' });
        expect(renderChecklist(state)).toBe('⏳ Reading a file...');

        state = completeStep(state, 'read_file');
        expect(renderChecklist(state)).toBe('✅ Read a file');
    });

    it('adds milestone steps already complete, in the finished tense', () => {
        const state = addStep(createChecklist(), p('Planning the approach...', 'Planned the approach'), { done: true });
        expect(renderChecklist(state)).toBe('✅ Planned the approach');
    });

    it('completes the matching key under interleaved parallel tool calls', () => {
        let state = createChecklist();
        state = addStep(state, p('Running an AWS CLI command...', 'Ran an AWS CLI command'), { key: 'execute_command' });
        state = addStep(state, p('Reading a file...', 'Read a file'), { key: 'read_file' });
        state = addStep(state, p('Searching file contents...', 'Searched file contents'), { key: 'grep' });

        // Results arrive out of order — each must complete its own step.
        state = completeStep(state, 'read_file');
        state = completeStep(state, 'execute_command');

        const lines = renderChecklist(state).split('\n');
        expect(lines[0]).toBe('✅ Ran an AWS CLI command');
        expect(lines[1]).toBe('✅ Read a file');
        expect(lines[2]).toBe('⏳ Searching file contents...');
    });

    it('completes the OLDEST pending step when the same tool runs twice', () => {
        const phrase = p('Running an AWS CLI command...', 'Ran an AWS CLI command');
        let state = createChecklist();
        state = addStep(state, phrase, { key: 'execute_command' });
        state = addStep(state, phrase, { key: 'execute_command' });

        state = completeStep(state, 'execute_command');

        const lines = renderChecklist(state).split('\n');
        expect(lines[0]).toBe('✅ Ran an AWS CLI command');
        expect(lines[1]).toBe('⏳ Running an AWS CLI command...');
    });

    it('is a no-op when no pending step matches the key', () => {
        const state = completeStep(addStep(createChecklist(), p('Reading a file...'), { key: 'read_file' }), 'grep');
        expect(renderChecklist(state)).toBe('⏳ Reading a file...');
    });

    it('is a no-op on an empty checklist', () => {
        expect(renderChecklist(completeStep(createChecklist(), 'grep'))).toBe('Getting started...');
    });

    it('collapses steps older than the last 6 into a summary line', () => {
        let state = createChecklist();
        for (let i = 1; i <= 8; i++) {
            state = addStep(state, p(`Step ${i}`), { done: true });
        }
        state = addStep(state, p('Step 9'), { key: 'grep' });

        const lines = renderChecklist(state).split('\n');
        expect(lines[0]).toBe('✅ 3 earlier steps completed');
        expect(lines).toContain('✅ Step 4');
        expect(lines).toContain('✅ Step 8');
        expect(lines).toContain('⏳ Step 9');
        expect(lines).not.toContain('✅ Step 1');
    });

    it('does not mutate the input state (pure functions)', () => {
        const original = createChecklist();
        const next = addStep(original, p('Step 1'));
        expect(original.steps.length).toBe(0);
        expect(next.steps.length).toBe(1);
    });

    it('completeStep does not mutate the input state or its step objects', () => {
        const original = addStep(createChecklist(), p('Reading a file...', 'Read a file'), { key: 'read_file' });
        const next = completeStep(original, 'read_file');

        expect(original.steps[0].done).toBe(false);
        expect(next.steps[0].done).toBe(true);
        expect(next.steps[0]).not.toBe(original.steps[0]);
        expect(renderChecklist(original)).toBe('⏳ Reading a file...');
    });

    it('singularizes the collapsed summary when exactly one earlier step completed', () => {
        let state = createChecklist();
        state = addStep(state, p('Step 1'), { done: true });
        for (let i = 2; i <= 7; i++) {
            state = addStep(state, p(`Step ${i}`), { key: 'grep' });
        }

        const lines = renderChecklist(state).split('\n');
        expect(lines[0]).toBe('✅ 1 earlier step completed');
        expect(lines).toHaveLength(7);
    });

    it('counts only completed steps in the collapsed summary', () => {
        let state = createChecklist();
        state = addStep(state, p('Step 1'), { done: true });
        state = addStep(state, p('Step 2'), { key: 'grep' });
        state = addStep(state, p('Step 3'), { done: true });
        for (let i = 4; i <= 9; i++) {
            state = addStep(state, p(`Step ${i}`), { done: true });
        }

        const lines = renderChecklist(state).split('\n');
        expect(lines[0]).toBe('✅ 2 earlier steps completed');
    });

    it('keeps exactly 6 entries expanded without a summary line', () => {
        let state = createChecklist();
        for (let i = 1; i <= 6; i++) {
            state = addStep(state, p(`Step ${i}`), { done: true });
        }

        const lines = renderChecklist(state).split('\n');
        expect(lines).toHaveLength(6);
        expect(lines[0]).toBe('✅ Step 1');

        state = addStep(state, p('Step 7'), { key: 'grep' });
        const grown = renderChecklist(state).split('\n');
        expect(grown).toHaveLength(7);
        expect(grown[0]).toBe('✅ 1 earlier step completed');
        expect(grown[1]).toBe('✅ Step 2');
    });

    it('completes the oldest pending step of any kind when no key is given', () => {
        let state = createChecklist();
        state = addStep(state, p('Planning the approach...', 'Planned the approach'), { done: true });
        state = addStep(state, p('Reading a file...', 'Read a file'), { key: 'read_file' });
        state = addStep(state, p('Searching file contents...'), { key: 'grep' });

        state = completeStep(state);

        const lines = renderChecklist(state).split('\n');
        expect(lines[1]).toBe('✅ Read a file');
        expect(lines[2]).toBe('⏳ Searching file contents...');
    });

    it('does not match a keyed completion against a keyless milestone step', () => {
        const state = completeStep(addStep(createChecklist(), p('Planning the approach...')), 'read_file');
        expect(renderChecklist(state)).toBe('⏳ Planning the approach...');
    });

    it('returns the same state object on a no-op completion', () => {
        const original = addStep(createChecklist(), p('Reading a file...'), { key: 'read_file' });
        expect(completeStep(original, 'grep')).toBe(original);
    });

    it('matches identical phrases only by key, never by phrase text', () => {
        const phrase = p('Running an AWS CLI command...', 'Ran an AWS CLI command');
        let state = createChecklist();
        state = addStep(state, phrase, { key: 'execute_command' });
        state = addStep(state, phrase, { key: 'aws_api' });

        state = completeStep(state, 'aws_api');

        const lines = renderChecklist(state).split('\n');
        expect(lines[0]).toBe('⏳ Running an AWS CLI command...');
        expect(lines[1]).toBe('✅ Ran an AWS CLI command');
    });
});

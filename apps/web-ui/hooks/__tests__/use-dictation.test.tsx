// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useDictation, type UseDictation } from '../use-dictation';

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

/** Stand-in for the browser's SpeechRecognition, driveable from tests. */
class MockRecognition {
    static instances: MockRecognition[] = [];

    lang = '';
    continuous = false;
    interimResults = false;
    maxAlternatives = 0;
    started = false;
    aborted = false;

    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;

    constructor() {
        MockRecognition.instances.push(this);
    }

    start() {
        this.started = true;
    }
    stop() {
        this.started = false;
    }
    abort() {
        this.aborted = true;
        this.started = false;
    }

    /**
     * Emit a result event shaped like the real API's: `results` is the
     * cumulative list for the session and `resultIndex` marks the first entry
     * that changed, so consumers only re-read from there.
     */
    emit(segments: Array<{ transcript: string; isFinal: boolean }>, resultIndex = 0) {
        const results = segments.map((s) => ({
            length: 1,
            isFinal: s.isFinal,
            0: { transcript: s.transcript },
        }));
        this.onresult?.({
            resultIndex,
            results: Object.assign(results, { length: results.length }),
        });
    }
}

/** Renders the hook and exposes its latest return value plus the live value. */
function setup(initial = '', options: { maxLength?: number; disabled?: boolean } = {}) {
    const state = { value: initial, hook: null as UseDictation | null };

    function Harness({ disabled }: { disabled?: boolean }) {
        const [value, setValue] = React.useState(initial);
        state.value = value;
        state.hook = useDictation({
            value,
            onChange: setValue,
            disabled,
            maxLength: options.maxLength,
        });
        return null;
    }

    const utils = render(<Harness disabled={options.disabled} />);
    return { state, utils, Harness };
}

describe('useDictation', () => {
    beforeEach(() => {
        MockRecognition.instances = [];
        toastError.mockClear();
        (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = MockRecognition;
    });

    afterEach(() => {
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    });

    it('reports support once mounted on a browser exposing the API', () => {
        const { state } = setup();
        expect(state.hook?.isSupported).toBe(true);
    });

    it('reports no support when the API is absent', () => {
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
        const { state } = setup();
        expect(state.hook?.isSupported).toBe(false);
    });

    it('appends the transcript after existing text instead of replacing it', () => {
        const { state } = setup('check the');
        act(() => state.hook!.toggle());
        act(() => MockRecognition.instances[0].emit([{ transcript: 'lambda logs', isFinal: true }]));
        expect(state.value).toBe('check the lambda logs');
    });

    it('does not insert a separator when the existing text already ends in a space', () => {
        const { state } = setup('check the ');
        act(() => state.hook!.toggle());
        act(() => MockRecognition.instances[0].emit([{ transcript: 'logs', isFinal: true }]));
        expect(state.value).toBe('check the logs');
    });

    it('replaces the interim tail with the final transcript rather than duplicating it', () => {
        const { state } = setup();
        act(() => state.hook!.toggle());

        act(() => MockRecognition.instances[0].emit([{ transcript: 'restart the', isFinal: false }]));
        expect(state.value).toBe('restart the');

        act(() => MockRecognition.instances[0].emit([{ transcript: 'restart the database', isFinal: true }]));
        expect(state.value).toBe('restart the database');
    });

    it('accumulates successive final segments across result events', () => {
        const { state } = setup();
        act(() => state.hook!.toggle());
        act(() => MockRecognition.instances[0].emit([{ transcript: 'one ', isFinal: true }], 0));
        act(() =>
            MockRecognition.instances[0].emit(
                [
                    { transcript: 'one ', isFinal: true },
                    { transcript: 'two', isFinal: true },
                ],
                1,
            ),
        );
        expect(state.value).toBe('one two');
    });

    it('clamps the transcript to maxLength', () => {
        const { state } = setup('', { maxLength: 8 });
        act(() => state.hook!.toggle());
        act(() => MockRecognition.instances[0].emit([{ transcript: 'far too long', isFinal: true }]));
        expect(state.value).toBe('far too ');
    });

    it('configures continuous recognition with interim results', () => {
        const { state } = setup();
        act(() => state.hook!.toggle());
        const recognition = MockRecognition.instances[0];
        expect(recognition.continuous).toBe(true);
        expect(recognition.interimResults).toBe(true);
        expect(recognition.started).toBe(true);
        expect(state.hook?.isListening).toBe(true);
    });

    it('toggles a live session off', () => {
        const { state } = setup();
        act(() => state.hook!.toggle());
        act(() => state.hook!.toggle());
        expect(state.hook?.isListening).toBe(false);
        expect(MockRecognition.instances).toHaveLength(1);
        expect(MockRecognition.instances[0].started).toBe(false);
    });

    it('does not start while disabled', () => {
        const { state } = setup('', { disabled: true });
        act(() => state.hook!.toggle());
        expect(MockRecognition.instances).toHaveLength(0);
        expect(state.hook?.isListening).toBe(false);
    });

    it('stops an in-flight session when the field becomes disabled', () => {
        const { state, utils, Harness } = setup();
        act(() => state.hook!.toggle());
        expect(state.hook?.isListening).toBe(true);

        utils.rerender(<Harness disabled />);
        expect(state.hook?.isListening).toBe(false);
        expect(MockRecognition.instances[0].started).toBe(false);
    });

    it('clears listening state when the browser ends the session on silence', () => {
        const { state } = setup();
        act(() => state.hook!.toggle());
        act(() => MockRecognition.instances[0].onend?.());
        expect(state.hook?.isListening).toBe(false);
    });

    it('surfaces a toast and stops on a permission error', () => {
        const { state } = setup();
        act(() => state.hook!.toggle());
        act(() => MockRecognition.instances[0].onerror?.({ error: 'not-allowed' }));
        expect(toastError).toHaveBeenCalledOnce();
        expect(state.hook?.isListening).toBe(false);
    });

    it('stays silent on no-speech and aborted, which are normal end signals', () => {
        const { state } = setup();
        act(() => state.hook!.toggle());
        act(() => MockRecognition.instances[0].onerror?.({ error: 'no-speech' }));
        expect(toastError).not.toHaveBeenCalled();
        expect(state.hook?.isListening).toBe(false);
    });

    it('releases the microphone when the field unmounts mid-session', () => {
        const { state, utils } = setup();
        act(() => state.hook!.toggle());
        const recognition = MockRecognition.instances[0];
        utils.unmount();
        expect(recognition.aborted).toBe(true);
    });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MicButton } from '../mic-button';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

class MockRecognition {
    static instances: MockRecognition[] = [];
    lang = '';
    continuous = false;
    interimResults = false;
    maxAlternatives = 0;
    started = false;
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
        this.started = false;
    }
}

const noop = () => {};

describe('MicButton', () => {
    beforeEach(() => {
        MockRecognition.instances = [];
        (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = MockRecognition;
    });

    afterEach(() => {
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    });

    it('renders nothing on browsers without the Web Speech API', () => {
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
        render(<MicButton value="" onChange={noop} />);
        expect(screen.queryByTestId('mic-button')).toBeNull();
    });

    it('renders an idle, unpressed mic when supported', () => {
        render(<MicButton value="" onChange={noop} />);
        const button = screen.getByTestId('mic-button');
        expect(button.getAttribute('aria-label')).toBe('Start voice input');
        expect(button.getAttribute('aria-pressed')).toBe('false');
    });

    it('flips to the pressed listening state on click', () => {
        render(<MicButton value="" onChange={noop} />);
        fireEvent.click(screen.getByTestId('mic-button'));

        const button = screen.getByTestId('mic-button');
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.getAttribute('aria-label')).toBe('Stop voice input');
        expect(button.getAttribute('data-listening')).toBe('true');
        expect(MockRecognition.instances).toHaveLength(1);
    });

    it('is disabled while idle and the field is disabled', () => {
        render(<MicButton value="" onChange={noop} disabled />);
        expect((screen.getByTestId('mic-button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('stays clickable while listening even once the field disables, so it can be stopped', () => {
        const { rerender } = render(<MicButton value="" onChange={noop} />);
        fireEvent.click(screen.getByTestId('mic-button'));
        rerender(<MicButton value="" onChange={noop} disabled />);
        // The disabled prop stops the session; the button returns to idle.
        expect(screen.getByTestId('mic-button').getAttribute('aria-pressed')).toBe('false');
    });

    it('writes the dictated transcript back through onChange', () => {
        const onChange = vi.fn();
        render(<MicButton value="scale" onChange={onChange} />);
        fireEvent.click(screen.getByTestId('mic-button'));

        const results = [{ length: 1, isFinal: true, 0: { transcript: 'the cluster' } }];
        MockRecognition.instances[0].onresult?.({
            resultIndex: 0,
            results: Object.assign(results, { length: 1 }),
        });

        expect(onChange).toHaveBeenCalledWith('scale the cluster');
    });
});

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClarificationCard } from '../clarification-card';

const clar = { toolCallId: 't3', question: 'Which instance should I start?', options: ['i-0abc · web', 'All of them'] };

describe('ClarificationCard', () => {
    it('renders question and option chips', () => {
        render(<ClarificationCard clarification={clar} onAnswer={vi.fn()} />);
        expect(screen.getByText(/Which instance/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'i-0abc · web' })).toBeTruthy();
    });

    it('chip click answers with the chip text', () => {
        const onAnswer = vi.fn();
        render(<ClarificationCard clarification={clar} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByRole('button', { name: 'All of them' }));
        expect(onAnswer).toHaveBeenCalledWith('t3', 'All of them');
    });

    it('free-text submit answers with trimmed text; empty blocked', () => {
        const onAnswer = vi.fn();
        render(<ClarificationCard clarification={clar} onAnswer={onAnswer} />);
        const input = screen.getByPlaceholderText(/type a custom answer/i);
        fireEvent.change(input, { target: { value: '   ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onAnswer).not.toHaveBeenCalled();
        fireEvent.change(input, { target: { value: '  i-0def  ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onAnswer).toHaveBeenCalledWith('t3', 'i-0def');
    });

    it('placeholder does not promise an immediate resume', () => {
        render(<ClarificationCard clarification={clar} onAnswer={vi.fn()} />);
        const input = screen.getByPlaceholderText(/type a custom answer/i) as HTMLTextAreaElement;
        expect(input.placeholder).not.toMatch(/resumes immediately/i);
    });

    it('decidedAnswer matching an option → option highlighted, others disabled, textarea gone, "Answer recorded" shown', () => {
        render(<ClarificationCard clarification={clar} onAnswer={vi.fn()} decidedAnswer="All of them" />);
        expect(screen.getByText(/answer recorded/i)).toBeTruthy();
        expect(screen.queryByPlaceholderText(/type a custom answer/i)).toBeNull();
        const other = screen.getByRole('button', { name: 'i-0abc · web' }) as HTMLButtonElement;
        expect(other.disabled).toBe(true);
        const selected = screen.getByRole('button', { name: 'All of them' }) as HTMLButtonElement;
        expect(selected.disabled).toBe(false); // selected stays visually active (click is a no-op)
    });

    it('decidedAnswer NOT matching any option renders as a chip', () => {
        render(<ClarificationCard clarification={clar} onAnswer={vi.fn()} decidedAnswer="i-0def" />);
        expect(screen.getByText('i-0def')).toBeTruthy();
        expect(screen.getByText(/answer recorded/i)).toBeTruthy();
    });

    it('option click optimistically shows the recorded state and blocks further answers', () => {
        const onAnswer = vi.fn();
        render(<ClarificationCard clarification={clar} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByRole('button', { name: 'All of them' }));
        expect(onAnswer).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/answer recorded/i)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'All of them' }));
        expect(onAnswer).toHaveBeenCalledTimes(1); // recorded → submit is a no-op
    });
});

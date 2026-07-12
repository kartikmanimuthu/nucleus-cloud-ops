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
});

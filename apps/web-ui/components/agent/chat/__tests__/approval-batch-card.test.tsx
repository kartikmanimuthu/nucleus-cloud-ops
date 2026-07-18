// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalBatchCard } from '../approval-batch-card';

const tools = [
    { toolCallId: 't1', toolName: 'get_aws_credentials', args: { accountId: '1' }, guard: null },
    { toolCallId: 't2', toolName: 'execute_command', args: { command: 'aws ec2 terminate-instances --instance-ids i-1' },
      guard: { toolCallId: 't2', toolName: 'execute_command', isMutative: true, severity: 'HIGH' as const, action: 'Terminates i-1', blastRadius: 'Instance destroyed', reversible: false, saferPath: 'Stop instead' } },
];

describe('ApprovalBatchCard', () => {
    it('renders one row per tool with severity badge on guarded rows', () => {
        render(<ApprovalBatchCard tools={tools} decisions={{}} onDecide={vi.fn()} onDecideRemaining={vi.fn()} />);
        expect(screen.getByText(/2 tool call/i)).toBeTruthy();
        expect(screen.getByText('HIGH')).toBeTruthy();
        expect(screen.getByText(/Terminates i-1/)).toBeTruthy();
    });

    it('per-row approve calls onDecide with that id only', () => {
        const onDecide = vi.fn();
        render(<ApprovalBatchCard tools={tools} decisions={{}} onDecide={onDecide} onDecideRemaining={vi.fn()} />);
        fireEvent.click(screen.getAllByRole('button', { name: /^Approve$/ })[0]);
        expect(onDecide).toHaveBeenCalledWith('t1', { approved: true });
    });

    it('safer path button rejects with the safer suggestion as reason', () => {
        const onDecide = vi.fn();
        render(<ApprovalBatchCard tools={tools} decisions={{}} onDecide={onDecide} onDecideRemaining={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /safer path/i }));
        expect(onDecide).toHaveBeenCalledWith('t2', { approved: false, reason: 'Use safer path instead: Stop instead' });
    });

    it('shows decision state instead of buttons for decided rows', () => {
        render(<ApprovalBatchCard tools={tools} decisions={{ t1: { approved: true } }} onDecide={vi.fn()} onDecideRemaining={vi.fn()} />);
        expect(screen.getByText(/✓ approved/i)).toBeTruthy();
    });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SubagentCard } from '../subagent-card';
import type { SubagentState } from '../run-state';

const DONE: SubagentState = {
    id: 'sub-1',
    role: 'Cost auditor',
    task: 'Audit lambda config',
    status: 'done',
    toolCount: 3,
    tokensIn: 900,
    tokensOut: 120,
    summary: 'Two functions are oversized.',
};

const RUNS = [{
    subagentId: 'sub-1',
    role: 'Cost auditor',
    task: 'Audit lambda config',
    status: 'done',
    toolCount: 3,
    tokensIn: 900,
    tokensOut: 120,
    summary: 'Two functions are oversized.',
    transcript: [
        { kind: 'ai', text: 'Listing functions first.' },
        { kind: 'tool', name: 'aws_read', text: '{"FunctionName":"api-worker"}' },
    ],
}];

const fetchMock = vi.fn();

function renderCard(ui: React.ReactElement) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: RUNS }) });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('SubagentCard transcript loading', () => {
    it('does no network work until the card is expanded', () => {
        renderCard(<SubagentCard subagent={DONE} threadId="thread-1" />);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetches the thread\'s persisted runs on expand and renders this sub-agent\'s transcript', async () => {
        renderCard(<SubagentCard subagent={DONE} threadId="thread-1" />);

        fireEvent.click(screen.getByRole('button'));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/subagents/thread-1'));
        expect(await screen.findByText('Listing functions first.')).toBeTruthy();
        expect(screen.getByText('{"FunctionName":"api-worker"}')).toBeTruthy();
        expect(screen.getByText('Transcript')).toBeTruthy();
    });

    it('still shows task and findings when no threadId is available, without fetching', async () => {
        renderCard(<SubagentCard subagent={DONE} />);

        fireEvent.click(screen.getByRole('button'));

        expect(await screen.findByText('Two functions are oversized.')).toBeTruthy();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('renders task and findings even when the transcript request fails', async () => {
        fetchMock.mockResolvedValue({ ok: false, json: async () => ({ success: false, error: 'db down' }) });
        renderCard(<SubagentCard subagent={DONE} threadId="thread-1" />);

        fireEvent.click(screen.getByRole('button'));

        expect(await screen.findByText('Two functions are oversized.')).toBeTruthy();
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.queryByText('Transcript')).toBeNull();
    });

    it('cannot be expanded while the sub-agent is still running', async () => {
        renderCard(<SubagentCard subagent={{ ...DONE, status: 'running', summary: undefined }} threadId="thread-1" />);

        expect(screen.getByRole('button')).toHaveProperty('disabled', true);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionSidebar } from '../session-sidebar';
import type { Thread } from '@/lib/queries/threads';

const mutateMock = vi.fn();
const useThreadsMock = vi.fn();

vi.mock('@/lib/queries/threads', () => ({
  useThreads: (...args: unknown[]) => useThreadsMock(...args),
  useDeleteThread: () => ({ mutate: mutateMock }),
}));

const now = new Date('2026-07-18T12:00:00.000Z');
const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const oneDayMs = 24 * 60 * 60 * 1000;

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    title: 'Untitled thread',
    createdAt: startOfToday,
    updatedAt: startOfToday,
    ...overrides,
  };
}

function baseProps() {
  return {
    activeId: 'none',
    onSelect: vi.fn(),
    onNew: vi.fn(),
    statuses: new Map<string, 'streaming' | 'attention' | 'idle'>(),
    collapsed: false,
    onToggleCollapse: vi.fn(),
  };
}

beforeEach(() => {
  vi.setSystemTime(now);
  useThreadsMock.mockReset();
  mutateMock.mockReset();
});

describe('SessionSidebar', () => {
  it('groups sessions by Today / Yesterday / Previous based on updatedAt', () => {
    const threads: Thread[] = [
      makeThread({ id: 'today-1', title: 'Today session', updatedAt: startOfToday + 1000 }),
      makeThread({ id: 'yesterday-1', title: 'Yesterday session', updatedAt: startOfToday - oneDayMs / 2 }),
      makeThread({ id: 'previous-1', title: 'Old session', updatedAt: startOfToday - oneDayMs * 5 }),
    ];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });

    render(<SessionSidebar {...baseProps()} />);

    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Yesterday')).toBeTruthy();
    expect(screen.getByText('Previous')).toBeTruthy();
    expect(screen.getByText('Today session')).toBeTruthy();
    expect(screen.getByText('Yesterday session')).toBeTruthy();
    expect(screen.getByText('Old session')).toBeTruthy();
  });

  it('shows a pulsing streaming status dot for a session in the statuses map', () => {
    const threads: Thread[] = [makeThread({ id: 'streaming-1', title: 'Streaming session' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });
    const statuses = new Map<string, 'streaming' | 'attention' | 'idle'>([['streaming-1', 'streaming']]);

    render(<SessionSidebar {...baseProps()} statuses={statuses} />);

    expect(screen.getByTestId('status-streaming')).toBeTruthy();
  });

  it('shows an amber attention dot for a session flagged attention', () => {
    const threads: Thread[] = [makeThread({ id: 'attn-1', title: 'Needs input' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });
    const statuses = new Map<string, 'streaming' | 'attention' | 'idle'>([['attn-1', 'attention']]);

    render(<SessionSidebar {...baseProps()} statuses={statuses} />);

    expect(screen.getByTestId('status-attention')).toBeTruthy();
  });

  it('renders no status dot for idle/undefined sessions', () => {
    const threads: Thread[] = [makeThread({ id: 'idle-1', title: 'Idle session' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });

    render(<SessionSidebar {...baseProps()} />);

    expect(screen.queryByTestId('status-streaming')).toBeNull();
    expect(screen.queryByTestId('status-attention')).toBeNull();
  });

  it('filters sessions by title via the search input', () => {
    const threads: Thread[] = [
      makeThread({ id: 'a', title: 'Deploy pipeline audit' }),
      makeThread({ id: 'b', title: 'Reboot flaky instance' }),
    ];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });

    render(<SessionSidebar {...baseProps()} />);

    const search = screen.getByPlaceholderText(/search/i);
    fireEvent.change(search, { target: { value: 'deploy' } });

    expect(screen.getByText('Deploy pipeline audit')).toBeTruthy();
    expect(screen.queryByText('Reboot flaky instance')).toBeNull();
  });

  it('fires onSelect with the thread id when a row is clicked', () => {
    const threads: Thread[] = [makeThread({ id: 'clickable', title: 'Click me' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });
    const props = baseProps();

    render(<SessionSidebar {...props} />);
    fireEvent.click(screen.getByText('Click me'));

    expect(props.onSelect).toHaveBeenCalledWith('clickable', undefined);
  });

  it('fires onNew when the "New chat" button is clicked', () => {
    useThreadsMock.mockReturnValue({ data: [], isLoading: false });
    const props = baseProps();

    render(<SessionSidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));

    expect(props.onNew).toHaveBeenCalled();
  });

  it('highlights the active session row', () => {
    const threads: Thread[] = [makeThread({ id: 'active-1', title: 'Active session' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });

    render(<SessionSidebar {...baseProps()} activeId="active-1" />);

    const row = screen.getByText('Active session').closest('[data-testid="session-row"]');
    expect(row?.className).toContain('bg-muted');
  });

  it('when collapsed, hides titles/search and shows only the icon strip', () => {
    const threads: Thread[] = [makeThread({ id: 'hidden-1', title: 'Hidden title' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });

    render(<SessionSidebar {...baseProps()} collapsed />);

    expect(screen.queryByText('Hidden title')).toBeNull();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });

  it('calls onToggleCollapse when the collapse toggle is clicked', () => {
    useThreadsMock.mockReturnValue({ data: [], isLoading: false });
    const props = baseProps();

    render(<SessionSidebar {...props} />);
    fireEvent.click(screen.getByTestId('sidebar-collapse-toggle'));

    expect(props.onToggleCollapse).toHaveBeenCalled();
  });

  it('renders an ephemeral "New chat" row for an unsent pending session and fires onSelect on click', () => {
    useThreadsMock.mockReturnValue({ data: [], isLoading: false });
    const props = baseProps();

    render(<SessionSidebar {...props} pendingSessions={['pending-1']} />);

    const pendingRow = screen.getByTestId('session-row-pending');
    expect(pendingRow).toBeTruthy();
    fireEvent.click(pendingRow);
    expect(props.onSelect).toHaveBeenCalledWith('pending-1');
  });

  it('drops a pending session from the ephemeral group once it appears in the server thread list', () => {
    const threads: Thread[] = [makeThread({ id: 'pending-1', title: 'Now persisted' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });

    render(<SessionSidebar {...baseProps()} pendingSessions={['pending-1']} />);

    // No ephemeral row — the persisted thread row is the single source now.
    expect(screen.queryByTestId('session-row-pending')).toBeNull();
    expect(screen.getByText('Now persisted')).toBeTruthy();
  });
});

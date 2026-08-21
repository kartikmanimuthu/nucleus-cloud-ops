// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createMongoAbility } from '@casl/ability';
import { AbilityProvider as CaslAbilityProvider } from '@casl/react';
import type { AppAbility } from '@nucleus/rbac';
import { SessionSidebar } from '../session-sidebar';
import { AbilityMetaContext, type AbilityMeta } from '@/providers/ability-provider';
import type { Thread } from '@/lib/queries/threads';

/**
 * The write controls in this sidebar are permission-gated, so these tests must
 * supply an ability — without a provider the hooks deny everything and every
 * click assertion fails for the wrong reason.
 *
 * `create Agent` / `delete Agent` are the real compiled subjects: POST /api/chat,
 * POST /api/threads and DELETE /api/threads/:id all declare subject `Agent`, not
 * the module key `AIOps`. Granting the module key here would make these tests
 * pass against an implementation that is wrong in production.
 */
const AGENT_WRITER = createMongoAbility([
  { action: 'read', subject: 'Agent' },
  { action: 'create', subject: 'Agent' },
  { action: 'delete', subject: 'Agent' },
]) as AppAbility;

const AGENT_READER = createMongoAbility([{ action: 'read', subject: 'Agent' }]) as AppAbility;

function renderSidebar(
  props: React.ComponentProps<typeof SessionSidebar>,
  ability: AppAbility = AGENT_WRITER,
) {
  const meta: AbilityMeta = {
    modules: [{ key: 'AIOps', label: 'AI Ops', icon: null, navPath: '/app/agent', sortOrder: 40 }],
    actions: [],
    subjects: [{ key: 'Agent', label: 'Agent', kind: 'capability', moduleKey: 'AIOps' }],
    // Required on AbilityMeta since the grantable cells began riding along with
    // the ability payload. Empty: these tests are not about the role grid.
    moduleActions: [],
    actionAliases: {},
    version: '1.1',
    isLoaded: true,
  };
  return render(
    <CaslAbilityProvider value={ability}>
      <AbilityMetaContext.Provider value={meta}>
        <SessionSidebar {...props} />
      </AbilityMetaContext.Provider>
    </CaslAbilityProvider>,
  );
}

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

    renderSidebar(baseProps());

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

    renderSidebar({ ...baseProps(), statuses });

    expect(screen.getByTestId('status-streaming')).toBeTruthy();
  });

  it('shows an amber attention dot for a session flagged attention', () => {
    const threads: Thread[] = [makeThread({ id: 'attn-1', title: 'Needs input' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });
    const statuses = new Map<string, 'streaming' | 'attention' | 'idle'>([['attn-1', 'attention']]);

    renderSidebar({ ...baseProps(), statuses });

    expect(screen.getByTestId('status-attention')).toBeTruthy();
  });

  it('renders no status dot for idle/undefined sessions', () => {
    const threads: Thread[] = [makeThread({ id: 'idle-1', title: 'Idle session' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });

    renderSidebar(baseProps());

    expect(screen.queryByTestId('status-streaming')).toBeNull();
    expect(screen.queryByTestId('status-attention')).toBeNull();
  });

  it('filters sessions by title via the search input', () => {
    const threads: Thread[] = [
      makeThread({ id: 'a', title: 'Deploy pipeline audit' }),
      makeThread({ id: 'b', title: 'Reboot flaky instance' }),
    ];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });

    renderSidebar(baseProps());

    const search = screen.getByPlaceholderText(/search/i);
    fireEvent.change(search, { target: { value: 'deploy' } });

    expect(screen.getByText('Deploy pipeline audit')).toBeTruthy();
    expect(screen.queryByText('Reboot flaky instance')).toBeNull();
  });

  it('fires onSelect with the thread id when a row is clicked', () => {
    const threads: Thread[] = [makeThread({ id: 'clickable', title: 'Click me' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });
    const props = baseProps();

    renderSidebar(props);
    fireEvent.click(screen.getByText('Click me'));

    expect(props.onSelect).toHaveBeenCalledWith('clickable', undefined);
  });

  it('fires onNew when the "New chat" button is clicked', () => {
    useThreadsMock.mockReturnValue({ data: [], isLoading: false });
    const props = baseProps();

    renderSidebar(props);
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));

    expect(props.onNew).toHaveBeenCalled();
  });

  it('highlights the active session row', () => {
    const threads: Thread[] = [makeThread({ id: 'active-1', title: 'Active session' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });

    renderSidebar({ ...baseProps(), activeId: "active-1" });

    const row = screen.getByText('Active session').closest('[data-testid="session-row"]');
    expect(row?.className).toContain('bg-muted');
  });

  it('when collapsed, hides titles/search and shows only the icon strip', () => {
    const threads: Thread[] = [makeThread({ id: 'hidden-1', title: 'Hidden title' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });

    renderSidebar({ ...baseProps(), collapsed: true });

    expect(screen.queryByText('Hidden title')).toBeNull();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });

  it('calls onToggleCollapse when the collapse toggle is clicked', () => {
    useThreadsMock.mockReturnValue({ data: [], isLoading: false });
    const props = baseProps();

    renderSidebar(props);
    fireEvent.click(screen.getByTestId('sidebar-collapse-toggle'));

    expect(props.onToggleCollapse).toHaveBeenCalled();
  });

  it('renders an ephemeral "New chat" row for an unsent pending session and fires onSelect on click', () => {
    useThreadsMock.mockReturnValue({ data: [], isLoading: false });
    const props = baseProps();

    renderSidebar({ ...props, pendingSessions: ['pending-1'] });

    const pendingRow = screen.getByTestId('session-row-pending');
    expect(pendingRow).toBeTruthy();
    fireEvent.click(pendingRow);
    expect(props.onSelect).toHaveBeenCalledWith('pending-1');
  });

  it('drops a pending session from the ephemeral group once it appears in the server thread list', () => {
    const threads: Thread[] = [makeThread({ id: 'pending-1', title: 'Now persisted' })];
    useThreadsMock.mockReturnValue({ data: threads, isLoading: false });

    renderSidebar({ ...baseProps(), pendingSessions: ['pending-1'] });

    // No ephemeral row — the persisted thread row is the single source now.
    expect(screen.queryByTestId('session-row-pending')).toBeNull();
    expect(screen.getByText('Now persisted')).toBeTruthy();
  });

  /**
   * A read-only role could start a new chat: the button was ungated, so the click
   * opened a session that then failed at POST /api/chat. Reading history is the
   * whole of what `read Agent` grants; creating and deleting are separate verbs
   * and must be separately visible as unavailable.
   */
  describe('read-only role', () => {
    it('disables "New chat" instead of letting the click through', () => {
      useThreadsMock.mockReturnValue({ data: [], isLoading: false });
      const props = baseProps();

      renderSidebar(props, AGENT_READER);

      const button = screen.getByRole('button', { name: /new chat/i }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);

      fireEvent.click(button);
      expect(props.onNew).not.toHaveBeenCalled();
    });

    it('disables the per-session delete control', () => {
      useThreadsMock.mockReturnValue({ data: [makeThread({ id: 'keep-me' })], isLoading: false });

      renderSidebar(baseProps(), AGENT_READER);

      const del = screen.getByRole('button', { name: /delete session/i }) as HTMLButtonElement;
      expect(del.disabled).toBe(true);

      fireEvent.click(del);
      expect(mutateMock).not.toHaveBeenCalled();
    });

    it('still lists existing sessions — read access is unaffected', () => {
      useThreadsMock.mockReturnValue({
        data: [makeThread({ id: 'past', title: 'Previous conversation' })],
        isLoading: false,
      });

      renderSidebar(baseProps(), AGENT_READER);

      expect(screen.getByText('Previous conversation')).toBeTruthy();
    });

    it('a writer role keeps both controls live — the negative half of the pair', () => {
      useThreadsMock.mockReturnValue({ data: [makeThread({ id: 'x' })], isLoading: false });
      const props = baseProps();

      renderSidebar(props);

      expect((screen.getByRole('button', { name: /new chat/i }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
      expect(props.onNew).toHaveBeenCalled();
    });
  });
});

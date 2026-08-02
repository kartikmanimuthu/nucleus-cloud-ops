// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RunRail, deriveStepTitle } from '../run-rail'
import type { RunState } from '../run-state'

// SubagentCard reads persisted transcripts through TanStack Query, so every rail
// render needs a client. Fetch is stubbed per-test; the default is an empty thread.
const fetchMock = vi.fn()

const render = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: [] }) })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

const EMPTY_RUN_STATE: RunState = {
  plan: [],
  planUpdatedBy: null,
  currentPhase: 'text',
  phases: [],
  pendingApproval: null,
  pendingClarifications: [],
  hasStructuredData: false,
  hasApprovalData: false,
  tokenUsage: { input: 0, output: 0 },
  subagents: [],
  usedSubagents: false,
}

const CONTEXT = { accountNames: [], modelLabel: '', skillName: null, toolCount: null, kbLabel: 'No knowledge base' }

describe('deriveStepTitle', () => {
  it('truncates a long CLI instruction to <=60 chars with an ellipsis', () => {
    const long =
      'Run the AWS CLI command to describe every EC2 instance in the account and capture the full JSON output for later parsing'
    const title = deriveStepTitle(long)
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.endsWith('…')).toBe(true)
  })

  it('leaves a short step unchanged', () => {
    expect(deriveStepTitle('Check RDS status')).toBe('Check RDS status')
  })

  it('splits on the first period+space clause boundary', () => {
    expect(deriveStepTitle('Describe instances. Then stop the idle ones.')).toBe('Describe instances')
  })

  it('splits on comma', () => {
    expect(deriveStepTitle('List all buckets, then filter by tag')).toBe('List all buckets')
  })

  it('splits on em-dash', () => {
    expect(deriveStepTitle('Scan accounts — collect right-sizing candidates')).toBe('Scan accounts')
  })
})

describe('RunRail', () => {
  it('renders a progress bar sized to done/total', () => {
    const runState: RunState = {
      ...EMPTY_RUN_STATE,
      currentPhase: 'execution',
      plan: [
        { step: 'Step one', status: 'completed' },
        { step: 'Step two', status: 'completed' },
        { step: 'Step three', status: 'in_progress' },
        { step: 'Step four', status: 'pending' },
      ],
    }
    render(<RunRail runState={runState} isStreaming context={CONTEXT} />)

    const fill = screen.getByTestId('plan-progress-fill')
    expect(fill.style.width).toBe('50%')
  })

  it('shows a short derived title for a long plan step, with the full text available as a tooltip', () => {
    const longStep =
      'Run the AWS CLI command to describe every EC2 instance in the account and capture the full JSON output for later parsing'
    const runState: RunState = {
      ...EMPTY_RUN_STATE,
      currentPhase: 'execution',
      plan: [{ step: longStep, status: 'in_progress' }],
    }
    render(<RunRail runState={runState} isStreaming context={CONTEXT} />)

    const row = screen.getByTestId('plan-step-0')
    expect(row.getAttribute('title')).toBe(longStep)
    expect(row.textContent?.length ?? 0).toBeLessThan(longStep.length)
  })

  it('shows "Recalling memory…" activity with a spinner during memory_recall, and the Status line does not repeat it', () => {
    const runState: RunState = { ...EMPTY_RUN_STATE, currentPhase: 'memory_recall' }
    render(<RunRail runState={runState} isStreaming context={CONTEXT} />)
    expect(screen.getByText('Recalling memory…')).toBeTruthy()
    // Only the Activity row's spinner label ("Recalling memory") should
    // exist — the Status line intentionally falls back to a generic label
    // instead of repeating the same phrase a second time on the same screen.
    expect(screen.getAllByText('Recalling memory')).toHaveLength(1)
  })

  it('shows "Saving memory…" activity with a spinner during memory_save, and the Status line does not repeat it', () => {
    const runState: RunState = { ...EMPTY_RUN_STATE, currentPhase: 'memory_save' }
    render(<RunRail runState={runState} isStreaming context={CONTEXT} />)
    expect(screen.getByText('Saving memory…')).toBeTruthy()
    expect(screen.getAllByText('Saving memory')).toHaveLength(1)
  })

  it('does not render a hardcoded "Generating..." badge', () => {
    const runState: RunState = {
      ...EMPTY_RUN_STATE,
      currentPhase: 'execution',
      plan: [{ step: 'Do the thing', status: 'in_progress' }],
    }
    render(<RunRail runState={runState} isStreaming context={CONTEXT} />)
    expect(screen.queryByText('Generating...')).toBeNull()
  })

  it('renders one card per sub-agent and counts only the running ones in the heading', () => {
    const runState: RunState = {
      ...EMPTY_RUN_STATE,
      usedSubagents: true,
      subagents: [
        { id: 's1', role: 'EC2 scanner', task: 'Scan EC2', status: 'running', toolCount: 2, tokensIn: 100, tokensOut: 20 },
        { id: 's2', role: 'RDS scanner', task: 'Scan RDS', status: 'done', toolCount: 5, tokensIn: 900, tokensOut: 80, summary: 'found it' },
      ],
    }
    render(<RunRail runState={runState} isStreaming context={CONTEXT} />)

    expect(screen.getByText(/^Sub-agents \(1 running/)).toBeTruthy()
    expect(screen.getByText('EC2 scanner')).toBeTruthy()
    expect(screen.getByText('RDS scanner')).toBeTruthy()
  })

  it('renders no sub-agent section when the run dispatched none', () => {
    render(<RunRail runState={EMPTY_RUN_STATE} isStreaming={false} context={CONTEXT} />)
    expect(screen.queryByText(/^Sub-agents/)).toBeNull()
  })

  // data-subagent parts are not persisted, so a reloaded thread arrives with an
  // empty `subagents` list. Without this reconstruction the cards — and the
  // transcripts Task 11 persists — would be unreachable after a refresh.
  it('rebuilds the sub-agent cards from persisted runs after a reload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [{
          subagentId: 's1', role: 'EC2 scanner', task: 'Scan EC2', status: 'done',
          toolCount: 4, tokensIn: 800, tokensOut: 60, summary: 'found it',
          transcript: [{ kind: 'ai', text: 'looked around' }],
        }],
      }),
    })

    render(<RunRail runState={{ ...EMPTY_RUN_STATE, usedSubagents: true }} isStreaming={false} context={CONTEXT} threadId="thread-1" />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/subagents/thread-1'))
    expect(await screen.findByText('EC2 scanner')).toBeTruthy()
    expect(screen.getByText(/^Sub-agents \(0 running/)).toBeTruthy()
  })

  it('does not fetch persisted runs for a thread that never dispatched', () => {
    render(<RunRail runState={EMPTY_RUN_STATE} isStreaming={false} context={CONTEXT} threadId="thread-1" />)
    // The settings fetch (Context line) is allowed; the sub-agent store fetch is not.
    expect(fetchMock).not.toHaveBeenCalledWith('/api/chat/subagents/thread-1')
  })

  it('prefers live sub-agent state over a persisted fetch while streaming', () => {
    const runState: RunState = {
      ...EMPTY_RUN_STATE,
      usedSubagents: true,
      subagents: [{ id: 's1', role: 'EC2 scanner', task: 'Scan EC2', status: 'running', toolCount: 1, tokensIn: 10, tokensOut: 1 }],
    }
    render(<RunRail runState={runState} isStreaming context={CONTEXT} threadId="thread-1" />)

    expect(screen.getByText(/^Sub-agents \(1 running/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/chat/subagents/thread-1')
  })

  it('still shows the pending-approval status row', () => {
    const runState: RunState = {
      ...EMPTY_RUN_STATE,
      pendingApproval: {
        batchId: 'b1',
        tools: [{ toolCallId: 't1', toolName: 'execute_command', args: {}, guard: null }],
      },
    }
    render(<RunRail runState={runState} isStreaming={false} context={CONTEXT} />)
    expect(screen.getByText('Awaiting approval')).toBeTruthy()
  })
})

// REGRESSION GUARD: a stream that dies mid-fan-out leaves live cards frozen at
// "running" — the terminal event was persisted server-side but never reached the
// client. Once streaming stops, the rail must reconcile those cards from
// agent_subagent_runs instead of spinning forever on a dead run.
describe('RunRail sub-agent reconciliation after stream death', () => {
  const liveRunning = {
    id: 'sa-9', role: 'EC2 auditor — 123456789012', task: 'audit', status: 'running' as const,
    toolCount: 5, tokensIn: 100, tokensOut: 50,
  }

  it('overrides a stale running card with the persisted terminal status', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [{
          subagentId: 'sa-9', role: 'EC2 auditor — 123456789012', task: 'audit', status: 'failed',
          toolCount: 17, tokensIn: 20000, tokensOut: 6800, summary: 'Model invocation was aborted.', transcript: null,
        }],
      }),
    })
    render(
      <RunRail
        runState={{ ...EMPTY_RUN_STATE, usedSubagents: true, subagents: [liveRunning] }}
        isStreaming={false}
        context={CONTEXT}
        threadId="thread-1"
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(/0 running/)).toBeTruthy()
    })
    // The abort is presented as a cancellation, not a sub-agent mistake.
    expect(screen.getByText(/Cancelled — the run was stopped/)).toBeTruthy()
  })

  it('leaves live running cards alone while the stream is still open', () => {
    render(
      <RunRail
        runState={{ ...EMPTY_RUN_STATE, usedSubagents: true, subagents: [liveRunning] }}
        isStreaming
        context={CONTEXT}
        threadId="thread-1"
      />,
    )
    expect(screen.getByText(/1 running/)).toBeTruthy()
  })
})

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AgentTurn } from '../agent-turn'
import { Transcript } from '../transcript'
import type { LooseMessage, TranscriptEvent } from '@/lib/agent-chat/events'
import type { RunState } from '@/components/agent/chat/run-state'
import type { DecisionMap } from '@/components/agent/chat/use-decisions'

const noop = () => {}

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
}

function baseProps(events: TranscriptEvent[]) {
  return {
    events,
    decisions: {} as DecisionMap,
    showWork: true,
    runState: EMPTY_RUN_STATE,
    isLastAssistantMessage: false,
    onDecide: noop,
    onDecideRemaining: noop,
    onAnswer: noop,
  }
}

function reasoningToolTextEvents(): TranscriptEvent[] {
  return [
    { kind: 'thinking', id: 'm1:0', phase: 'execution', text: 'Thinking about the next step', streaming: false },
    {
      kind: 'tool',
      id: 'm1:tool:tc1',
      toolCallId: 'tc1',
      toolName: 'execute_command',
      input: { command: 'aws ec2 describe-instances' },
      output: 'ok',
      status: 'done',
    },
    { kind: 'answer', id: 'm1:2', text: 'Here is the answer.', streaming: false },
  ]
}

describe('AgentTurn', () => {
  it('renders exactly one avatar, one ThinkingBlock, one ToolRow, one answer', () => {
    const events = reasoningToolTextEvents()
    render(<AgentTurn {...baseProps(events)} />)

    expect(screen.getAllByTestId('agent-turn-avatar')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Thought/ })).toHaveLength(1)
    expect(screen.getByText('execute_command')).toBeTruthy()
    expect(screen.getByText('Here is the answer.')).toBeTruthy()
  })

  it('showWork:false hides process rows behind a "Show work (2 steps)" toggle', () => {
    const events = reasoningToolTextEvents()
    render(<AgentTurn {...baseProps(events)} showWork={false} />)

    expect(screen.queryByRole('button', { name: /Thought/ })).toBeNull()
    expect(screen.queryByText('execute_command')).toBeNull()
    expect(screen.getByText('Here is the answer.')).toBeTruthy()

    const toggle = screen.getByText('Show work (2 steps)')
    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: /Thought/ })).toBeTruthy()
    expect(screen.getByText('execute_command')).toBeTruthy()
  })

  it('groups >=3 consecutive done tool events via groupEvents', () => {
    const events: TranscriptEvent[] = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'a', input: {}, output: 'ok', status: 'done' },
      { kind: 'tool', id: 't2', toolCallId: 'c2', toolName: 'b', input: {}, output: 'ok', status: 'done' },
      { kind: 'tool', id: 't3', toolCallId: 'c3', toolName: 'c', input: {}, output: 'ok', status: 'done' },
    ]
    render(<AgentTurn {...baseProps(events)} />)

    expect(screen.getByText('Ran 3 tools')).toBeTruthy()
    // With "Show work" on, the group renders expanded by default — the inner
    // tool rows are visible without another click.
    expect(screen.getByText('a')).toBeTruthy()
  })

  it('renders the approval interrupt card only when isLastAssistantMessage and runState has a pending batch', () => {
    const events: TranscriptEvent[] = [{ kind: 'answer', id: 'm3:0', text: 'Working on it.', streaming: false }]
    const runState: RunState = {
      ...EMPTY_RUN_STATE,
      pendingApproval: {
        batchId: 'b1',
        tools: [{ toolCallId: 'tc9', toolName: 'execute_command', args: { command: 'rm -rf /' }, guard: null }],
      },
    }

    const { rerender } = render(
      <AgentTurn {...baseProps(events)} runState={runState} isLastAssistantMessage={false} />
    )
    expect(screen.queryByTestId('approval-batch-card')).toBeNull()

    rerender(<AgentTurn {...baseProps(events)} runState={runState} isLastAssistantMessage={true} />)
    expect(screen.getByTestId('approval-batch-card')).toBeTruthy()
  })

  it('interleaves narration text between tool blocks in true event order', () => {
    const events: TranscriptEvent[] = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'first_tool', input: {}, output: 'ok', status: 'done' },
      { kind: 'answer', id: 'a1', text: 'Step 1 complete, moving on.', streaming: false },
      { kind: 'tool', id: 't2', toolCallId: 'c2', toolName: 'second_tool', input: {}, output: 'ok', status: 'done' },
    ]
    const { container } = render(<AgentTurn {...baseProps(events)} />)

    const html = container.innerHTML
    const firstTool = html.indexOf('first_tool')
    const narration = html.indexOf('Step 1 complete')
    const secondTool = html.indexOf('second_tool')
    expect(firstTool).toBeGreaterThan(-1)
    expect(narration).toBeGreaterThan(firstTool)
    expect(secondTool).toBeGreaterThan(narration)
  })

  it('renders a working indicator for a still-empty streaming last turn, not a lone avatar', () => {
    render(
      <AgentTurn
        {...baseProps([])}
        runState={{ ...EMPTY_RUN_STATE, currentPhase: 'memory_recall' }}
        isLastAssistantMessage={true}
        isStreaming={true}
      />
    )
    expect(screen.getByTestId('working-indicator')).toBeTruthy()
    expect(screen.getByText(/Recalling memory/)).toBeTruthy()
  })

  it('renders nothing at all for an empty settled turn', () => {
    const { container } = render(
      <AgentTurn {...baseProps([])} isLastAssistantMessage={false} isStreaming={false} />
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('agent-turn-avatar')).toBeNull()
  })

  it('keeps a working indicator visible during streaming with rows, but not while a decision is pending', () => {
    const events: TranscriptEvent[] = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'a', input: {}, output: 'ok', status: 'done' },
    ]
    const { rerender } = render(
      <AgentTurn {...baseProps(events)} isLastAssistantMessage={true} isStreaming={true} />
    )
    expect(screen.getByTestId('working-indicator')).toBeTruthy()

    const pendingRunState: RunState = {
      ...EMPTY_RUN_STATE,
      pendingApproval: {
        batchId: 'b1',
        tools: [{ toolCallId: 'tc9', toolName: 'execute_command', args: {}, guard: null }],
      },
    }
    rerender(
      <AgentTurn {...baseProps(events)} runState={pendingRunState} isLastAssistantMessage={true} isStreaming={true} />
    )
    expect(screen.queryByTestId('working-indicator')).toBeNull()
  })
})

describe('AgentTurn — three-tier differentiation', () => {
  it('elevates a final/revision report into a titled Report card when the turn ran tools', () => {
    const events: TranscriptEvent[] = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'execute_command', input: { command: 'aws ecs describe-services' }, output: 'ok', status: 'done' },
      { kind: 'answer', id: 'a1', phase: 'revision', text: 'Deployment Failure Investigation report.', streaming: false },
    ]
    render(<AgentTurn {...baseProps(events)} />)

    const card = screen.getByTestId('report-card')
    expect(card).toBeTruthy()
    expect(card.textContent).toContain('Report')
    expect(card.textContent).toContain('Deployment Failure Investigation report.')
  })

  it('does NOT card a report-phase answer when the turn ran no tools (plain chat)', () => {
    const events: TranscriptEvent[] = [
      { kind: 'answer', id: 'a1', phase: 'final', text: 'Just a chat reply.', streaming: false },
    ]
    render(<AgentTurn {...baseProps(events)} />)

    expect(screen.queryByTestId('report-card')).toBeNull()
    expect(screen.getByText('Just a chat reply.')).toBeTruthy()
  })

  it('demotes execution-phase narration into the work rail (hidden behind Show work)', () => {
    const events: TranscriptEvent[] = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'execute_command', input: {}, output: 'ok', status: 'done' },
      { kind: 'answer', id: 'a1', phase: 'execution', text: 'Found the cluster, now describing it.', streaming: false },
      { kind: 'answer', id: 'a2', phase: 'revision', text: 'Final compiled report.', streaming: false },
    ]
    // showWork off: narration is work, so it collapses with the tools; only the
    // report card remains visible.
    render(<AgentTurn {...baseProps(events)} showWork={false} />)

    expect(screen.queryByText('Found the cluster, now describing it.')).toBeNull()
    expect(screen.getByTestId('report-card')).toBeTruthy()
    // Narration + tool = 2 hidden steps.
    expect(screen.getByRole('button', { name: /Show work \(2 steps\)/ })).toBeTruthy()
  })

  it('keeps execution narration in true order between tool rows when work is shown', () => {
    const events: TranscriptEvent[] = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'first_tool', input: {}, output: 'ok', status: 'done' },
      { kind: 'answer', id: 'a1', phase: 'execution', text: 'Step 1 complete, moving on.', streaming: false },
      { kind: 'tool', id: 't2', toolCallId: 'c2', toolName: 'second_tool', input: {}, output: 'ok', status: 'done' },
    ]
    const { container } = render(<AgentTurn {...baseProps(events)} />)

    const html = container.innerHTML
    const firstTool = html.indexOf('first_tool')
    const narration = html.indexOf('Step 1 complete')
    const secondTool = html.indexOf('second_tool')
    expect(narration).toBeGreaterThan(firstTool)
    expect(secondTool).toBeGreaterThan(narration)
  })
})

describe('Transcript', () => {
  const passthrough = {
    toolVisibility: new Map<string, string>(),
    decisions: {} as DecisionMap,
    showWork: true,
    runState: EMPTY_RUN_STATE,
    isStreaming: false,
    onDecide: noop,
    onDecideRemaining: noop,
    onAnswer: noop,
  }

  it('renders nothing for an empty decision-carrier user message', () => {
    const messages: LooseMessage[] = [
      { id: 'u1', role: 'user', parts: [] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
    ]
    render(<Transcript messages={messages} {...passthrough} />)

    expect(screen.queryByTestId('user-bubble')).toBeNull()
    expect(screen.getByText('Done.')).toBeTruthy()
  })

  it('renders a right-aligned bubble for a real user message', () => {
    const messages: LooseMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello there' }] },
    ]
    render(<Transcript messages={messages} {...passthrough} />)

    expect(screen.getByText('Hello there')).toBeTruthy()
    expect(screen.getByTestId('user-bubble')).toBeTruthy()
  })

  it('reuses the cached build for a settled (non-last) message across a messages-array identity change', () => {
    const messages: LooseMessage[] = [
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'First answer.' }] },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Second answer.' }] },
    ]
    const { rerender } = render(<Transcript messages={messages} {...passthrough} isStreaming />)
    expect(screen.getByText('First answer.')).toBeTruthy()
    expect(screen.getByText('Second answer.')).toBeTruthy()

    // New array reference, identical message objects/part counts — simulates
    // the reference churn `useChat` produces on every streamed token.
    const rechurned = [...messages]
    rerender(<Transcript messages={rechurned} {...passthrough} isStreaming />)
    expect(screen.getByText('First answer.')).toBeTruthy()
    expect(screen.getByText('Second answer.')).toBeTruthy()
  })

  it('does not duplicate a tool row after an approval resume moves toolVisibility to a later message', () => {
    // Message N is last and owns an output-less (pending-approval) tool part —
    // toolVisibility currently awards toolCallId 'tc1' to N.
    const messageN: LooseMessage = {
      id: 'n',
      role: 'assistant',
      parts: [{ type: 'tool-execute_command', toolCallId: 'tc1', toolName: 'execute_command', input: { command: 'aws ec2 describe-instances' } }],
    }
    const { rerender } = render(
      <Transcript messages={[messageN]} {...passthrough} toolVisibility={new Map([['tc1', 'n']])} />
    )
    expect(screen.getAllByText('execute_command')).toHaveLength(1)

    // Resume: a NEW message N+1 re-emits the SAME toolCallId with real output
    // (the "input-only twin" pattern) — N's parts are untouched, so its part
    // count/cache key doesn't change, but it's no longer the last message.
    // toolVisibility now (correctly) awards 'tc1' to N+1.
    const messageNAfterResume: LooseMessage = { ...messageN }
    const messageNPlus1: LooseMessage = {
      id: 'n+1',
      role: 'assistant',
      parts: [{ type: 'tool-execute_command', toolCallId: 'tc1', toolName: 'execute_command', input: { command: 'aws ec2 describe-instances' }, output: 'ok', state: 'output-available' }],
    }
    rerender(
      <Transcript
        messages={[messageNAfterResume, messageNPlus1]}
        {...passthrough}
        toolVisibility={new Map([['tc1', 'n+1']])}
      />
    )

    // Exactly one row for tc1 — owned by N+1, not duplicated (stale) in N.
    expect(screen.getAllByText('execute_command')).toHaveLength(1)
  })
})

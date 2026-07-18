// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AgentTurn } from '../agent-turn'
import { Transcript } from '../transcript'
import type { LooseMessage } from '@/lib/agent-chat/events'
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
}

function baseProps(message: LooseMessage) {
  return {
    message,
    isStreaming: false,
    toolVisibility: new Map<string, string>(
      (message.parts ?? [])
        .filter((p: any) => p.toolCallId)
        .map((p: any) => [p.toolCallId, message.id])
    ),
    decisions: {} as DecisionMap,
    showWork: true,
    runState: EMPTY_RUN_STATE,
    isLastAssistantMessage: false,
    onDecide: noop,
    onDecideRemaining: noop,
    onAnswer: noop,
  }
}

function reasoningToolTextMessage(): LooseMessage {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'Thinking about the next step' },
      {
        type: 'tool-execute_command',
        toolCallId: 'tc1',
        toolName: 'execute_command',
        input: { command: 'aws ec2 describe-instances' },
        output: 'ok',
        state: 'output-available',
      },
      { type: 'text', text: 'Here is the answer.' },
    ],
  }
}

describe('AgentTurn', () => {
  it('renders exactly one avatar, one ThinkingBlock, one ToolRow, one answer', () => {
    const message = reasoningToolTextMessage()
    render(<AgentTurn {...baseProps(message)} />)

    expect(screen.getAllByTestId('agent-turn-avatar')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Thought/ })).toHaveLength(1)
    expect(screen.getByText('execute_command')).toBeTruthy()
    expect(screen.getByText('Here is the answer.')).toBeTruthy()
  })

  it('showWork:false hides process rows behind a "Show work (2 steps)" toggle', () => {
    const message = reasoningToolTextMessage()
    render(<AgentTurn {...baseProps(message)} showWork={false} />)

    expect(screen.queryByRole('button', { name: /Thought/ })).toBeNull()
    expect(screen.queryByText('execute_command')).toBeNull()
    expect(screen.getByText('Here is the answer.')).toBeTruthy()

    const toggle = screen.getByText('Show work (2 steps)')
    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: /Thought/ })).toBeTruthy()
    expect(screen.getByText('execute_command')).toBeTruthy()
  })

  it('groups >=3 consecutive done tool events via groupEvents', () => {
    const message: LooseMessage = {
      id: 'm2',
      role: 'assistant',
      parts: [
        { type: 'tool-a', toolCallId: 'c1', toolName: 'a', input: {}, output: 'ok', state: 'output-available' },
        { type: 'tool-b', toolCallId: 'c2', toolName: 'b', input: {}, output: 'ok', state: 'output-available' },
        { type: 'tool-c', toolCallId: 'c3', toolName: 'c', input: {}, output: 'ok', state: 'output-available' },
      ],
    }
    render(<AgentTurn {...baseProps(message)} />)

    expect(screen.getByText('Ran 3 tools')).toBeTruthy()
    expect(screen.queryByText('a')).toBeNull()
  })

  it('renders the approval interrupt card only when isLastAssistantMessage and runState has a pending batch', () => {
    const message: LooseMessage = { id: 'm3', role: 'assistant', parts: [{ type: 'text', text: 'Working on it.' }] }
    const runState: RunState = {
      ...EMPTY_RUN_STATE,
      pendingApproval: {
        batchId: 'b1',
        tools: [{ toolCallId: 'tc9', toolName: 'execute_command', args: { command: 'rm -rf /' }, guard: null }],
      },
    }

    const { rerender } = render(
      <AgentTurn {...baseProps(message)} runState={runState} isLastAssistantMessage={false} />
    )
    expect(screen.queryByTestId('approval-batch-card')).toBeNull()

    rerender(<AgentTurn {...baseProps(message)} runState={runState} isLastAssistantMessage={true} />)
    expect(screen.getByTestId('approval-batch-card')).toBeTruthy()
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
})

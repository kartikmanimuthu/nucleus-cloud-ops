// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RunRail, deriveStepTitle } from '../run-rail'
import type { RunState } from '../run-state'

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

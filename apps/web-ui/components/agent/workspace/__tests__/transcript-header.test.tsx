// @vitest-environment jsdom
import { beforeAll, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TranscriptHeader } from '../transcript-header'
import type { RunState } from '@/components/agent/chat/run-state'

// jsdom lacks these APIs that Radix's DropdownMenu (Popper + pointer capture)
// relies on when opening/positioning its portal content.
beforeAll(() => {
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false)
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {})
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {})
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})
  if (typeof (globalThis as any).ResizeObserver === 'undefined') {
    ;(globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

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

function planOf(doneCount: number, total: number): RunState['plan'] {
  return Array.from({ length: total }, (_, i) => ({
    step: `Step ${i + 1}`,
    status: i < doneCount ? 'completed' : 'pending',
  }))
}

describe('TranscriptHeader', () => {
  it('idle (not streaming, no phases) renders just the title, no stepper', () => {
    render(
      <TranscriptHeader
        title="Untitled conversation"
        runState={EMPTY_RUN_STATE}
        isStreaming={false}
        elapsedMs={null}
        onMenuAction={vi.fn()}
      />
    )

    expect(screen.getByText('Untitled conversation')).toBeTruthy()
    expect(screen.queryByTestId('phase-stepper')).toBeNull()
  })

  it('execution phase with 12/19 plan: Plan done, Execute active showing 12/19', () => {
    const runState: RunState = {
      ...EMPTY_RUN_STATE,
      currentPhase: 'execution',
      phases: [
        { phase: 'planning', node: 'planner', ts: 1 },
        { phase: 'execution', node: 'executor', ts: 2 },
      ],
      plan: planOf(12, 19),
    }

    render(
      <TranscriptHeader
        title="Run"
        runState={runState}
        isStreaming
        elapsedMs={5000}
        onMenuAction={vi.fn()}
      />
    )

    const stepper = screen.getByTestId('phase-stepper')
    expect(stepper).toBeTruthy()

    const planStep = screen.getByTestId('step-plan')
    expect(planStep.getAttribute('data-status')).toBe('done')

    const executeStep = screen.getByTestId('step-execute')
    expect(executeStep.getAttribute('data-status')).toBe('active')
    expect(executeStep.textContent).toContain('12/19')

    const reflectStep = screen.getByTestId('step-reflect')
    expect(reflectStep.getAttribute('data-status')).toBe('upcoming')

    const reviseStep = screen.getByTestId('step-revise')
    expect(reviseStep.getAttribute('data-status')).toBe('upcoming')
  })

  it('lap 2 execution: Reflect/Revise from lap 1 must NOT be stuck done (canonical position, not cumulative history)', () => {
    // planning -> execution -> reflection -> revision -> execution (lap 2).
    // currentPhase is 'execution' again, with 25+ iterations still ahead —
    // Reflect and Revise must read as upcoming for THIS lap, not "done"
    // just because they occurred somewhere earlier in the full history.
    const runState: RunState = {
      ...EMPTY_RUN_STATE,
      currentPhase: 'execution',
      phases: [
        { phase: 'planning', node: 'planner', ts: 1 },
        { phase: 'execution', node: 'executor', ts: 2 },
        { phase: 'reflection', node: 'reflector', ts: 3 },
        { phase: 'revision', node: 'reviser', ts: 4 },
        { phase: 'execution', node: 'executor', ts: 5 },
      ],
      plan: planOf(3, 19),
    }

    render(
      <TranscriptHeader
        title="Run"
        runState={runState}
        isStreaming
        elapsedMs={5000}
        onMenuAction={vi.fn()}
      />
    )

    expect(screen.getByTestId('step-plan').getAttribute('data-status')).toBe('done')
    expect(screen.getByTestId('step-execute').getAttribute('data-status')).toBe('active')
    expect(screen.getByTestId('step-reflect').getAttribute('data-status')).toBe('upcoming')
    expect(screen.getByTestId('step-revise').getAttribute('data-status')).toBe('upcoming')
  })

  it('final phase marks every step done', () => {
    const runState: RunState = {
      ...EMPTY_RUN_STATE,
      currentPhase: 'final',
      phases: [
        { phase: 'planning', node: 'planner', ts: 1 },
        { phase: 'execution', node: 'executor', ts: 2 },
        { phase: 'reflection', node: 'reflector', ts: 3 },
        { phase: 'revision', node: 'reviser', ts: 4 },
        { phase: 'final', node: 'final', ts: 5 },
      ],
      plan: planOf(19, 19),
    }

    render(
      <TranscriptHeader
        title="Run"
        runState={runState}
        isStreaming={false}
        elapsedMs={12345}
        onMenuAction={vi.fn()}
      />
    )

    for (const key of ['plan', 'execute', 'reflect', 'revise']) {
      expect(screen.getByTestId(`step-${key}`).getAttribute('data-status')).toBe('done')
    }
  })

  it('formats the elapsed timer as mm:ss', () => {
    render(
      <TranscriptHeader
        title="Run"
        runState={EMPTY_RUN_STATE}
        isStreaming={false}
        elapsedMs={65_000}
        onMenuAction={vi.fn()}
      />
    )
    expect(screen.getByTestId('elapsed-timer').textContent).toBe('01:05')
  })

  it('renders no elapsed timer when elapsedMs is null', () => {
    render(
      <TranscriptHeader
        title="Run"
        runState={EMPTY_RUN_STATE}
        isStreaming={false}
        elapsedMs={null}
        onMenuAction={vi.fn()}
      />
    )
    expect(screen.queryByTestId('elapsed-timer')).toBeNull()
  })

  it('overflow menu fires onMenuAction for each item', async () => {
    const onMenuAction = vi.fn()
    render(
      <TranscriptHeader
        title="Run"
        runState={EMPTY_RUN_STATE}
        isStreaming={false}
        elapsedMs={null}
        onMenuAction={onMenuAction}
      />
    )

    // Radix's DropdownMenuTrigger opens on pointerdown (or Enter/Space), not
    // a plain click event — jsdom won't synthesize that from fireEvent.click.
    fireEvent.keyDown(screen.getByRole('button', { name: /more actions/i }), { key: 'Enter' })
    const exportItem = await screen.findByText('Export as Markdown')
    fireEvent.click(exportItem)

    expect(onMenuAction).toHaveBeenCalledWith('export-md')
  })

  it('offers transcript-PDF and report-PDF export menu items', async () => {
    const onMenuAction = vi.fn()
    render(
      <TranscriptHeader
        title="Run"
        runState={EMPTY_RUN_STATE}
        isStreaming={false}
        elapsedMs={null}
        onMenuAction={onMenuAction}
      />
    )

    fireEvent.keyDown(screen.getByRole('button', { name: /more actions/i }), { key: 'Enter' })
    fireEvent.click(await screen.findByText('Export transcript (PDF)'))
    expect(onMenuAction).toHaveBeenCalledWith('export-pdf')

    fireEvent.keyDown(screen.getByRole('button', { name: /more actions/i }), { key: 'Enter' })
    fireEvent.click(await screen.findByText('Export report (PDF)'))
    expect(onMenuAction).toHaveBeenCalledWith('export-report')
  })
})

// @vitest-environment jsdom
import { beforeAll, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from '../composer'
import type { ComposerContext } from '../composer-pickers'

// jsdom lacks these APIs that Radix's Popover/Select (Popper + pointer capture)
// rely on when opening/positioning their portal content.
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

function baseContext(overrides: Partial<ComposerContext> = {}): ComposerContext {
  return {
    accounts: { available: [], selectedIds: [], onChange: vi.fn() },
    model: { available: [], selectedId: '', onChange: vi.fn() },
    skill: { available: [], selectedId: null, onChange: vi.fn() },
    kb: { available: [], selectedIds: [], onChange: vi.fn() },
    tools: { available: [], selectedIds: [], onChange: vi.fn() },
    ...overrides,
  }
}

function baseProps(overrides: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return {
    value: '',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    isStreaming: false,
    context: baseContext(),
    attachments: [],
    onAttach: vi.fn(),
    mode: 'fast',
    onModeChange: vi.fn(),
    autoApprove: true,
    onAutoApproveChange: vi.fn(),
    showTools: false,
    onShowToolsChange: vi.fn(),
    ...overrides,
  }
}

describe('Composer', () => {
  it('Enter submits when there is text', () => {
    const onSubmit = vi.fn()
    render(<Composer {...baseProps({ value: 'hello agent', onSubmit })} />)

    const textarea = screen.getByTestId('composer-input')
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('Shift+Enter does not submit (inserts newline instead)', () => {
    const onSubmit = vi.fn()
    render(<Composer {...baseProps({ value: 'hello agent', onSubmit })} />)

    const textarea = screen.getByTestId('composer-input')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Enter does not submit when the composer is empty', () => {
    const onSubmit = vi.fn()
    render(<Composer {...baseProps({ value: '   ', onSubmit })} />)

    const textarea = screen.getByTestId('composer-input')
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('removing the account chip calls context.accounts.onChange with an empty selection', () => {
    const onChange = vi.fn()
    const context = baseContext({
      accounts: {
        available: [{ accountId: '111', name: 'Acme Corp' }],
        selectedIds: ['111'],
        onChange,
      },
    })
    render(<Composer {...baseProps({ context })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear accounts' }))

    expect(onChange).toHaveBeenCalledWith([])
  })

  it('removing the model chip calls context.model.onChange with an empty id', () => {
    const onChange = vi.fn()
    const context = baseContext({
      model: {
        available: [{ id: 'claude', label: 'Claude 4.5 Sonnet', provider: 'bedrock' }],
        selectedId: 'claude',
        onChange,
      },
    })
    render(<Composer {...baseProps({ context })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear model' }))

    expect(onChange).toHaveBeenCalledWith('')
  })

  it('removing the skill chip calls context.skill.onChange with null', () => {
    const onChange = vi.fn()
    const context = baseContext({
      skill: {
        available: [{ id: 'sk-1', name: 'Cost Audit', description: 'Audits spend' }],
        selectedId: 'sk-1',
        onChange,
      },
    })
    render(<Composer {...baseProps({ context })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear skill' }))

    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('char counter is hidden well under the limit', () => {
    render(<Composer {...baseProps({ value: 'a'.repeat(100) })} />)
    expect(screen.queryByTestId('char-counter')).toBeNull()
  })

  it('char counter is visible near the limit', () => {
    render(<Composer {...baseProps({ value: 'a'.repeat(1900) })} />)
    expect(screen.getByTestId('char-counter').textContent).toBe('1900/2000')
  })

  it('shows Send while idle and calls onSubmit when clicked', () => {
    const onSubmit = vi.fn()
    const onStop = vi.fn()
    render(<Composer {...baseProps({ value: 'hello', isStreaming: false, onSubmit, onStop })} />)

    fireEvent.click(screen.getByTestId('composer-send-button'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
  })

  it('shows Stop while streaming and calls onStop when clicked', () => {
    const onSubmit = vi.fn()
    const onStop = vi.fn()
    render(<Composer {...baseProps({ value: 'hello', isStreaming: true, onSubmit, onStop })} />)

    fireEvent.click(screen.getByTestId('composer-send-button'))

    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disables the send button when the composer is empty and idle', () => {
    render(<Composer {...baseProps({ value: '   ', isStreaming: false })} />)
    expect((screen.getByTestId('composer-send-button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the send button (as Stop) enabled while streaming, even with empty input', () => {
    render(<Composer {...baseProps({ value: '', isStreaming: true })} />)
    expect((screen.getByTestId('composer-send-button') as HTMLButtonElement).disabled).toBe(false)
  })
})

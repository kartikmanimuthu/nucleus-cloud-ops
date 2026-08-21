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
    autoLoadSkills: true,
    onAutoLoadSkillsChange: vi.fn(),
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

  it('groups model options by provider (with a header per group) and filters them via search', () => {
    const onChange = vi.fn()
    const context = baseContext({
      model: {
        available: [
          { id: 'm-bedrock', label: 'Claude 4.5 Sonnet', provider: 'bedrock' },
          { id: 'm-openai', label: 'GPT-4o', provider: 'openai' },
          { id: 'm-ollama', label: 'Llama 3', provider: 'ollama' },
        ],
        selectedId: 'm-bedrock',
        onChange,
      },
    })
    render(<Composer {...baseProps({ context })} />)

    fireEvent.click(screen.getByTestId('model-chip-trigger'))

    // Grouped under a header per provider, in the monolith's stable order.
    expect(screen.getByText('Bedrock')).toBeTruthy()
    expect(screen.getByText('OpenAI')).toBeTruthy()
    expect(screen.getByText('Ollama')).toBeTruthy()
    expect(screen.getByTestId('model-option-m-bedrock')).toBeTruthy()
    expect(screen.getByTestId('model-option-m-openai')).toBeTruthy()
    expect(screen.getByTestId('model-option-m-ollama')).toBeTruthy()

    // Search filters the list down to the matching provider/model only.
    fireEvent.change(screen.getByPlaceholderText('Search models…'), { target: { value: 'Llama' } })

    expect(screen.queryByTestId('model-option-m-bedrock')).toBeNull()
    expect(screen.queryByTestId('model-option-m-openai')).toBeNull()
    expect(screen.getByTestId('model-option-m-ollama')).toBeTruthy()
    expect(screen.queryByText('Bedrock')).toBeNull()
    expect(screen.getByText('Ollama')).toBeTruthy()
  })

  it('selecting a filtered model option calls context.model.onChange with its id', () => {
    const onChange = vi.fn()
    const context = baseContext({
      model: {
        available: [
          { id: 'm-bedrock', label: 'Claude 4.5 Sonnet', provider: 'bedrock' },
          { id: 'm-ollama', label: 'Llama 3', provider: 'ollama' },
        ],
        selectedId: 'm-bedrock',
        onChange,
      },
    })
    render(<Composer {...baseProps({ context })} />)

    fireEvent.click(screen.getByTestId('model-chip-trigger'))
    fireEvent.click(screen.getByTestId('model-option-m-ollama'))

    expect(onChange).toHaveBeenCalledWith('m-ollama')
  })

  it('locks just the skill picker via context.skill.disabled while account/model stay open', () => {
    const context = baseContext({
      skill: {
        available: [{ id: 'sk-1', name: 'Cost Audit', description: 'Audits spend' }],
        selectedId: null,
        onChange: vi.fn(),
        disabled: true,
      },
    })
    render(<Composer {...baseProps({ context })} />)

    expect((screen.getByTestId('skill-chip-trigger') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('account-chip-trigger') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('model-chip-trigger') as HTMLButtonElement).disabled).toBe(false)
  })

  it('char counter is hidden well under the limit', () => {
    render(<Composer {...baseProps({ value: 'a'.repeat(100) })} />)
    expect(screen.queryByTestId('char-counter')).toBeNull()
  })

  // Thresholds live in composer.tsx: MAX_CHARS 6000, CHAR_WARNING_THRESHOLD 5400.
  it('char counter is visible near the limit', () => {
    render(<Composer {...baseProps({ value: 'a'.repeat(5500) })} />)
    expect(screen.getByTestId('char-counter').textContent).toBe('5500/6000')
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

  /**
   * A list the caller may not read and a list that is genuinely empty render
   * identically unless the picker is told the difference. Each of these lists sits
   * behind its own permission (read Account / read Skill / read AIOps), so a role
   * can be denied one while holding another — and "Select accounts" over an empty
   * popover reads as a broken app rather than as an authorisation boundary.
   */
  describe('denied pickers say so', () => {
    it('the account chip reports denial instead of offering an empty selection', () => {
      const context = baseContext({
        accounts: {
          available: [],
          selectedIds: [],
          onChange: vi.fn(),
          denied: 'You do not have permission to read Account.',
        },
      })
      render(<Composer {...baseProps({ context })} />)

      const trigger = screen.getByTestId('account-chip-trigger') as HTMLButtonElement
      expect(trigger.textContent).toBe('No account access')
      // Inert: there is nothing behind it to open.
      expect(trigger.disabled).toBe(true)
    })

    it('the skill chip distinguishes "denied" from the user choosing no skill', () => {
      const context = baseContext({
        skill: {
          available: [],
          selectedId: null,
          onChange: vi.fn(),
          denied: 'You do not have permission to read Skill.',
        },
      })
      render(<Composer {...baseProps({ context })} />)

      const trigger = screen.getByTestId('skill-chip-trigger') as HTMLButtonElement
      expect(trigger.textContent).toBe('No skill access')
      expect(trigger.disabled).toBe(true)
    })

    it('an allowed-but-empty account list still invites a selection', () => {
      // The negative half of the pair: without it, a bug that showed the denial
      // copy unconditionally would pass every assertion above.
      render(<Composer {...baseProps()} />)

      const trigger = screen.getByTestId('account-chip-trigger') as HTMLButtonElement
      expect(trigger.textContent).toBe('Select accounts')
      expect(trigger.disabled).toBe(false)
    })
  })
})

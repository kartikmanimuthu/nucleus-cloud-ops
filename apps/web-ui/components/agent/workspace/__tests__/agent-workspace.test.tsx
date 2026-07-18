// @vitest-environment jsdom
import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AgentWorkspace } from '../agent-workspace'

// jsdom lacks the layout/pointer APIs Radix + the composer's auto-grow textarea
// touch on mount, and next/navigation's router; stub them so a bare render works.
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
  // Every picker/history fetch resolves to an empty-but-valid payload so the
  // shell mounts without a live server.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ messages: [], skills: [], servers: [], knowledgeBases: [], data: { models: [], providers: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

function renderWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AgentWorkspace />
    </QueryClientProvider>,
  )
}

afterEach(() => cleanup())

describe('AgentWorkspace', () => {
  it('mounts the shell with a composer and a rail for the initial session', () => {
    renderWorkspace()
    // One initial session view is mounted → its composer input + run rail render.
    expect(screen.getByTestId('composer-input')).toBeTruthy()
    expect(screen.getByTestId('run-rail')).toBeTruthy()
  })

  it('exposes a mobile New chat control and the sidebar rail toggle', () => {
    renderWorkspace()
    // Both the mobile top bar and the sidebar render a New chat control (CSS,
    // not conditional rendering, hides one per breakpoint), plus the sidebar
    // collapse toggle.
    expect(screen.getAllByRole('button', { name: /new chat/i }).length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('sidebar-collapse-toggle').length).toBeGreaterThan(0)
  })
})

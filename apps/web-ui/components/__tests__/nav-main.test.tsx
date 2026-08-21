// @vitest-environment jsdom
//
// Declared per-file — see hooks/__tests__/use-nav-gate.test.tsx: Vitest 4
// removed environmentMatchGlobs, so vitest.config.ts's jsdom glob is inert.

/**
 * NavMain / useVisibleItems — precedence between a subject that claims a
 * nav entry's href and that entry's declared `module` annotation.
 *
 * This is the exact real-world case that motivated the fix: all nine
 * "Agentic Ops" entries in lib/nav-config.ts declare `module: "AIOps"`, but
 * Providers (/app/agent-ops/providers) is ALSO claimed by the `Provider`
 * subject's navPath. A role can be readable on AIOps generally (e.g. via the
 * `Agent` subject) while explicitly denied on `Provider` — the module
 * annotation must not outrank that more specific subject claim, or Providers
 * would stay visible to someone who cannot read it.
 *
 * hooks/__tests__/use-nav-gate.test.tsx only exercises useNavGate() directly
 * (canSeeHref/canSeeModule/canSeeSubject) — it never renders NavMain, so it
 * cannot observe nav-main.tsx's OWN `canSee` closure, which decides which of
 * those answers wins. That is what this file is for.
 */

import * as React from 'react'
import { Bot } from 'lucide-react'
import { createMongoAbility } from '@casl/ability'
import { AbilityProvider as CaslAbilityProvider } from '@casl/react'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { AbilityMetaContext, type AbilityMeta } from '@/providers/ability-provider'
import { SidebarProvider } from '@/components/ui/sidebar'
import { NavMain, type NavItem } from '../nav-main'

// jsdom lacks the pointer/layout APIs Radix's Tooltip + Collapsible (used by
// SidebarMenuButton/Collapsible under SidebarProvider) touch on mount — same
// polyfills as components/rbac/__tests__/gated.test.tsx.
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
  // SidebarProvider's mobile detection (hooks/use-mobile.tsx) calls
  // window.matchMedia, which jsdom does not implement.
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList)
})

// nav-main.tsx calls usePathname() for active-link highlighting, but it also
// decides whether a category's Collapsible defaults open (defaultOpen =
// itemActive || childActive) — a closed category hides its Radix
// CollapsibleContent (`hidden`), which getByRole/queryByRole treat as
// invisible. Matching the "AI Ops" entry's href keeps the category expanded
// regardless of gating, which is what this test needs to assert on.
vi.mock('next/navigation', () => ({
  usePathname: () => '/app/agent',
}))

afterEach(() => cleanup())

// Mirrors the real registry shape for the Agentic Ops category: one module
// (AIOps) that owns several subjects, two of which are relevant here.
const META: AbilityMeta = {
  modules: [{ key: 'AIOps', label: 'AI Ops', icon: null, navPath: '/app/agent', sortOrder: 40 }],
  actions: [],
  subjects: [
    { key: 'Agent', label: 'Agent', kind: 'resource', moduleKey: 'AIOps', navPath: '/app/agent', sortOrder: 10 },
    {
      key: 'Provider',
      label: 'Provider',
      kind: 'resource',
      moduleKey: 'AIOps',
      navPath: '/app/agent-ops/providers',
      sortOrder: 70,
    },
  ],
  moduleActions: [],
  actionAliases: {},
  version: '1.0',
  isLoaded: true,
}

// Modeled directly on the real Agentic Ops category in lib/nav-config.ts:
// both entries declare `module: "AIOps"`, and Providers is additionally
// claimed by the `Provider` subject's navPath.
const items: NavItem[] = [
  {
    title: 'Agentic Ops',
    icon: Bot,
    items: [
      { title: 'AI Ops', href: '/app/agent', module: 'AIOps' },
      { title: 'Providers', href: '/app/agent-ops/providers', module: 'AIOps' },
    ],
  },
]

function renderNav(rules: { action: string; subject: string; inverted?: boolean }[]) {
  const ability = createMongoAbility(rules as never)
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <CaslAbilityProvider value={ability as never}>
        <AbilityMetaContext.Provider value={META}>
          <SidebarProvider>{children}</SidebarProvider>
        </AbilityMetaContext.Provider>
      </CaslAbilityProvider>
    )
  }
  return render(<NavMain items={items} />, { wrapper: Wrapper })
}

describe('NavMain — subject-vs-module precedence', () => {
  it('hides an entry whose owning subject is denied, even though its module is readable', () => {
    // Read granted on Agent (so the AIOps module DOES have a readable
    // subject — canSeeModule("AIOps") would say true if it were consulted)
    // but NOT on Provider. Mirrors "AI Ops: read, Provider: deny read".
    renderNav([{ action: 'read', subject: 'Agent' }])

    // The category's OTHER entry, whose href the Provider subject does not
    // claim, still renders — the category is not wiped out wholesale.
    expect(screen.getByRole('link', { name: 'AI Ops' })).toBeTruthy()

    // Providers is claimed by the Provider subject via navPath, and that
    // subject is denied read. If the module annotation ("AIOps") were
    // consulted first, this would incorrectly render — that is the exact bug
    // this test guards against.
    expect(screen.queryByRole('link', { name: 'Providers' })).toBeNull()
  })

  it('shows the subject-owned entry once its subject is granted read', () => {
    renderNav([{ action: 'read', subject: 'Agent' }, { action: 'read', subject: 'Provider' }])

    expect(screen.getByRole('link', { name: 'AI Ops' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Providers' })).toBeTruthy()
  })
})

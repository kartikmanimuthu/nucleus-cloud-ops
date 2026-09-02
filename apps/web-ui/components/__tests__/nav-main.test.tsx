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
import { navMenus } from '@/lib/nav-config'
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
// Held in a vi.hoisted() box, not a bare `let`, because vi.mock factories are
// hoisted above module-level declarations — a plain variable would be in TDZ if
// the factory ever read it eagerly. The second describe below re-points this so
// ITS category renders expanded; the default keeps the first describe unchanged.
const nav = vi.hoisted(() => ({ pathname: '/app/agent' }))

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
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

// ── The degraded registry: a subject whose navPath is missing ────────────────
//
// Reported on production: "Scale Sentinel" rendered for a role holding NOTHING
// on Inventory. Cause was a NULL navPath on the ScalingAudit subject —
// 20260812100000 set it only inside `INSERT ... ON CONFLICT DO NOTHING`, so a
// pre-existing row never received it (see
// 20260820000000_backfill_subject_navpaths).
//
// With no navPath, resolveNavOwner finds no owner for the href and canSeeHref
// returns TRUE — a deliberate fail-open (use-can.ts:142-147). The only thing
// standing between that and a link visible to everyone is the entry's `module`
// annotation, which Scale Sentinel did not have.
//
// So this fixture OMITS the navPath on purpose. The existing
// scale-sentinel-nav-and-scan.test.tsx pins the healthy case (navPath present,
// subject gates it); this pins the broken-registry case, which is the state
// production was actually in and the one nothing covered.
describe('NavMain — a subject with no navPath must not fail open', () => {
  const DEGRADED_META: AbilityMeta = {
    modules: [
      { key: 'Inventory', label: 'Inventory', icon: null, navPath: '/app/inventory', sortOrder: 30 },
      { key: 'Accounts', label: 'Accounts', icon: null, navPath: '/app/accounts', sortOrder: 20 },
    ],
    actions: [],
    subjects: [
      {
        key: 'Resource',
        label: 'Resource',
        kind: 'resource',
        moduleKey: 'Inventory',
        navPath: '/app/inventory',
        sortOrder: 10,
      },
      // navPath deliberately null — the production defect this guards.
      {
        key: 'ScalingAudit',
        label: 'Scale Sentinel',
        kind: 'resource',
        moduleKey: 'Inventory',
        navPath: null,
        sortOrder: 40,
      },
      {
        key: 'Account',
        label: 'Account',
        kind: 'resource',
        moduleKey: 'Accounts',
        navPath: '/app/accounts',
        sortOrder: 10,
      },
    ],
    moduleActions: [],
    actionAliases: {},
    version: '1.0',
    isLoaded: true,
  }

  // Taken FROM lib/nav-config.ts, not retyped from it. A hand-copied entry
  // would keep asserting that an annotated entry is gated while the real Scale
  // Sentinel entry quietly lost its annotation — green against the regression
  // it exists to catch. Reading the real rows means deleting
  // `module: "Inventory"` from nav-config.ts fails this file.
  //
  // Trimmed to the two entries in play: AWS Accounts (the positive control,
  // visible in both cases) and Scale Sentinel.
  const cloudOps = navMenus.find((m) => m.title === 'Cloud Operations')
  const realEntry = (title: string) => {
    const entry = cloudOps?.items?.find((i) => i.title === title)
    if (!entry) throw new Error(`nav-config.ts has no Cloud Operations entry '${title}'`)
    return entry
  }

  const degradedItems: NavItem[] = [
    {
      title: 'Cloud Operations',
      icon: Bot,
      items: [realEntry('AWS Accounts'), realEntry('Scale Sentinel')],
    },
  ]

  function renderDegraded(rules: { action: string; subject: string; inverted?: boolean }[]) {
    const ability = createMongoAbility(rules as never)
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <CaslAbilityProvider value={ability as never}>
          <AbilityMetaContext.Provider value={DEGRADED_META}>
            <SidebarProvider>{children}</SidebarProvider>
          </AbilityMetaContext.Provider>
        </CaslAbilityProvider>
      )
    }
    return render(<NavMain items={degradedItems} />, { wrapper: Wrapper })
  }

  beforeAll(() => {
    // A category whose Collapsible is closed marks its children `hidden`, which
    // getByRole treats as absent — every assertion below would pass vacuously,
    // green against both the bug and the fix. defaultOpen needs an active child
    // (nav-main.tsx:133,159).
    //
    // It must be the AWS ACCOUNTS href, not the Scale Sentinel one: childActive
    // is computed over the FILTERED subs, so pointing it at the entry these
    // tests expect to be hidden would collapse the category precisely when the
    // fix works — the assertion would then pass for the wrong reason. Anchoring
    // on the entry that stays visible in both cases keeps the control honest.
    nav.pathname = '/app/accounts'
  })

  it('hides Scale Sentinel for a role with no Inventory grant', () => {
    // The exact production role: read on Accounts, nothing on Inventory.
    renderDegraded([{ action: 'read', subject: 'Account' }])

    // Positive control — proves the category is expanded and links do render.
    expect(screen.getByRole('link', { name: 'AWS Accounts' })).toBeTruthy()

    // Without the `module: "Inventory"` annotation this is the FAIL-OPEN: no
    // subject claims the href, so canSeeHref says true and the link renders
    // for a role with zero Inventory permission.
    expect(screen.queryByRole('link', { name: 'Scale Sentinel' })).toBeNull()
  })

  it('still shows Scale Sentinel when the Inventory module is readable', () => {
    // The fallback must not be a blanket deny: a role that can read a subject
    // of Inventory still reaches the page, so the link must stay.
    renderDegraded([
      { action: 'read', subject: 'Account' },
      { action: 'read', subject: 'Resource' },
    ])

    expect(screen.getByRole('link', { name: 'Scale Sentinel' })).toBeTruthy()
  })
})

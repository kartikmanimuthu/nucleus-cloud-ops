// @vitest-environment jsdom
//
// Declared per-file rather than relying on vitest.config.ts's
// `environmentMatchGlobs` — that option was REMOVED in Vitest 4, so the config's
// `['**/__tests__/**/*.test.tsx', 'jsdom']` entry is inert and every component
// test under it runs in the `node` environment with no `document`.

/**
 * Client gating hooks.
 *
 * The contexts are supplied directly rather than through AbilityProvider: what
 * is under test is the DECISION logic — alias resolution, row-aware conditions,
 * navPath ownership — not the fetch that feeds it. The ability itself is a real
 * CASL ability built from real compiled-shape rules.
 */

import React from 'react';
import { createMongoAbility } from '@casl/ability';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppAbility } from '@nucleus/rbac';

import { AbilityProvider as CaslAbilityProvider } from '@casl/react';

import {
    AbilityMetaContext,
    type AbilityMeta,
    type AbilityModule,
    type AbilitySubjectDef,
} from '@/providers/ability-provider';
import { useAccessibleModules, useAppAbility, useCan, useDenialReason, useNavGate } from '../use-can';

const MODULES: AbilityModule[] = [
    { key: 'Schedules', label: 'Schedules', icon: null, navPath: '/app/schedules', sortOrder: 10 },
    { key: 'Settings', label: 'Settings', icon: null, navPath: '/app/settings', sortOrder: 90 },
    // A real module with no destination of its own.
    { key: 'Dashboard', label: 'Dashboard', icon: null, navPath: null, sortOrder: 0 },
];

/**
 * Subject→module links, mirroring the real registry (rbac_subject_modules).
 *
 * These are LOAD-BEARING, not scenery. Compiled rules name subjects, never
 * modules, so module visibility can only be derived through this map. The
 * fixture deliberately matches production's shape, where some modules own a
 * subject of the same name (Settings, Dashboard) and some do not (Schedules owns
 * Schedule + SpotGuard) — that asymmetry is precisely why the bug was invisible:
 * checks against a module key happened to work for the former and never for the
 * latter.
 */
const SUBJECTS: AbilitySubjectDef[] = [
    { key: 'Schedule', label: 'Schedule', kind: 'resource', moduleKey: 'Schedules' },
    { key: 'SpotGuard', label: 'Spot Guard', kind: 'capability', moduleKey: 'Schedules' },
    { key: 'Settings', label: 'Settings', kind: 'capability', moduleKey: 'Settings' },
    { key: 'User', label: 'User', kind: 'resource', moduleKey: 'Settings' },
    { key: 'Dashboard', label: 'Dashboard', kind: 'capability', moduleKey: 'Dashboard' },
];

function wrapperFor(ability: AppAbility, meta: Partial<AbilityMeta> = {}) {
    const value: AbilityMeta = {
        modules: MODULES,
        actions: [],
        subjects: SUBJECTS,
        // Required on AbilityMeta since the grantable cells began riding along
        // with the ability payload. Empty is the honest default here: these
        // tests exercise nav gating and can/cannot, not the role grid.
        moduleActions: [],
        actionAliases: {},
        version: '1.1',
        isLoaded: true,
        ...meta,
    };
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <CaslAbilityProvider value={ability}>
                <AbilityMetaContext.Provider value={value}>{children}</AbilityMetaContext.Provider>
            </CaslAbilityProvider>
        );
    };
}

describe('useAppAbility — no provider mounted', () => {
    /**
     * @casl/react v7's useAbility() THROWS when its provider is absent; it does
     * not return null. Before this was handled, adding a gating hook to any
     * component that could render outside <Providers> replaced the page with an
     * error boundary — a missing provider turned a permission check into an
     * outage. Denying is the only safe answer, so it must be the answer.
     */
    it('denies instead of throwing', () => {
        expect(() => renderHook(() => useAppAbility())).not.toThrow();

        const { result } = renderHook(() => useAppAbility());
        expect(result.current.can('read', 'Schedule' as never)).toBe(false);
    });

    it('lets useCan resolve to false rather than crash the subtree', () => {
        const { result } = renderHook(() => useCan('read', 'Account'));
        expect(result.current).toBe(false);
    });
});

describe('useCan', () => {
    it('reflects a plain grant', () => {
        const ability = createMongoAbility([{ action: 'read', subject: 'Schedule' }]) as AppAbility;
        const { result } = renderHook(() => useCan('read', 'Schedule'), { wrapper: wrapperFor(ability) });

        expect(result.current).toBe(true);
    });

    it('resolves an aliased verb to its terminal action', () => {
        // Rules are compiled with terminal verbs only, so a component asking about
        // 'execute' must be translated the same way the server translates it —
        // otherwise every aliased control renders disabled for everyone.
        const ability = createMongoAbility([{ action: 'update', subject: 'Schedule' }]) as AppAbility;
        const wrapper = wrapperFor(ability, { actionAliases: { execute: 'update' } });

        expect(renderHook(() => useCan('execute', 'Schedule'), { wrapper }).result.current).toBe(true);
        // Without the alias map the same check must fail — proving the pass above
        // came from resolution and not from an unconditional grant.
        expect(
            renderHook(() => useCan('execute', 'Schedule'), { wrapper: wrapperFor(ability) }).result.current
        ).toBe(false);
    });

    it('evaluates conditions against a supplied row', () => {
        const ability = createMongoAbility([
            { action: 'update', subject: 'Schedule', conditions: { accountId: { $in: ['dev-1'] } } },
        ]) as AppAbility;
        const wrapper = wrapperFor(ability);

        expect(renderHook(() => useCan('update', 'Schedule', { accountId: 'dev-1' }), { wrapper }).result.current)
            .toBe(true);
        expect(renderHook(() => useCan('update', 'Schedule', { accountId: 'prod-9' }), { wrapper }).result.current)
            .toBe(false);
    });

    it('without a row a conditional grant reads as permitted — why call sites must pass one', () => {
        // CASL answers "could this ever be allowed" for a bare subject type. The
        // server closes this in authorize(); on the client it means a row-less
        // check enables a button the API may still refuse. Pinned so the
        // behaviour cannot change silently under the call sites that rely on it.
        const ability = createMongoAbility([
            { action: 'update', subject: 'Schedule', conditions: { accountId: { $in: ['dev-1'] } } },
        ]) as AppAbility;

        expect(renderHook(() => useCan('update', 'Schedule'), { wrapper: wrapperFor(ability) }).result.current)
            .toBe(true);
    });

    it('an empty ability denies everything — the pre-load default', () => {
        const ability = createMongoAbility([]) as AppAbility;

        expect(renderHook(() => useCan('read', 'Schedule'), { wrapper: wrapperFor(ability) }).result.current)
            .toBe(false);
    });
});

describe('useDenialReason', () => {
    it('returns null when allowed, and the rule reason when not', () => {
        const ability = createMongoAbility([
            {
                action: 'update',
                subject: 'Schedule',
                conditions: { accountId: { $in: ['dev-1'] } },
                reason: 'Restricted to your assigned accounts',
            },
        ]) as AppAbility;
        const wrapper = wrapperFor(ability);

        expect(
            renderHook(() => useDenialReason('update', 'Schedule', { accountId: 'dev-1' }), { wrapper })
                .result.current
        ).toBeNull();
        expect(
            renderHook(() => useDenialReason('update', 'Schedule', { accountId: 'prod-9' }), { wrapper })
                .result.current
        ).toBe('Restricted to your assigned accounts');
    });

    it('falls back to a generic line when the rule carries no reason', () => {
        const ability = createMongoAbility([]) as AppAbility;
        const { result } = renderHook(() => useDenialReason('delete', 'Schedule'), {
            wrapper: wrapperFor(ability),
        });

        expect(result.current).toBe('You do not have permission to delete Schedule.');
    });
});

describe('useAccessibleModules', () => {
    it('returns only readable modules that have a destination', () => {
        const ability = createMongoAbility([
            { action: 'read', subject: 'Schedule' },
            { action: 'read', subject: 'Dashboard' },
        ]) as AppAbility;
        const { result } = renderHook(() => useAccessibleModules(), { wrapper: wrapperFor(ability) });

        // Dashboard is readable but has no navPath, so it is not a nav entry.
        expect(result.current.map((m) => m.key)).toEqual(['Schedules']);
    });
});

describe('useNavGate', () => {
    const ability = createMongoAbility([{ action: 'read', subject: 'Schedule' }]) as AppAbility;

    it('governs a child route by its owning module', () => {
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor(ability) });

        expect(result.current.canSeeHref('/app/schedules')).toBe(true);
        expect(result.current.canSeeHref('/app/schedules/new')).toBe(true);
        expect(result.current.canSeeHref('/app/settings/members')).toBe(false);
    });

    it('leaves a destination no module claims visible', () => {
        // Fail-open, deliberately: a missing registry row must not read as an
        // outage. The route is still guarded server-side.
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor(ability) });

        expect(result.current.canSeeHref('/app/some-unregistered-page')).toBe(true);
    });

    it('does not match a sibling path that merely shares a prefix string', () => {
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor(ability) });

        // '/app/settings-export' must NOT be claimed by navPath '/app/settings'.
        expect(result.current.canSeeHref('/app/settings-export')).toBe(true);
    });

    it('reports not-loaded before rules arrive', () => {
        const { result } = renderHook(() => useNavGate(), {
            wrapper: wrapperFor(createMongoAbility([]) as AppAbility, { isLoaded: false }),
        });

        expect(result.current.isLoaded).toBe(false);
    });
});

/**
 * canSeeModule exists because href inference silently under-gated the sidebar.
 *
 * canSeeHref maps a path to a module by prefix against rbac_modules.navPath, and
 * most destinations do not match one: `/app/agent-ops` is not a child of AIOps's
 * `/app/agent` (the prefix test needs `/app/agent/`), and `/app/memory`,
 * `/app/knowledge-base`, `/app/skills` and `/app/audit` match nothing at all.
 * Unmatched paths fall through to "visible", so those entries were shown to every
 * role regardless of permission.
 */
describe('useNavGate — canSeeModule', () => {
    it('permits a module the role can read', () => {
        const ability = createMongoAbility([{ action: 'read', subject: 'Schedule' }]) as AppAbility;
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor(ability) });

        expect(result.current.canSeeModule('Schedules')).toBe(true);
    });

    it('denies a module the role cannot read', () => {
        const ability = createMongoAbility([{ action: 'read', subject: 'Schedule' }]) as AppAbility;
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor(ability) });

        expect(result.current.canSeeModule('Settings')).toBe(false);
    });

    it('denies an unknown module key rather than defaulting to visible', () => {
        // Opposite of canSeeHref's fallback, deliberately: an unmatched HREF
        // usually means "belongs to no module", but an unmatched MODULE KEY means
        // the annotation is wrong or the module was retired. Failing closed makes
        // that visible instead of quietly exposing the entry.
        const ability = createMongoAbility([{ action: 'manage', subject: 'all' }]) as AppAbility;
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor(ability) });

        expect(result.current.canSeeModule('NotARealModule')).toBe(false);
    });

    it('gates a path that href inference could never resolve', () => {
        // `/app/agent-ops` under AIOps: the exact case that was leaking.
        const modules: AbilityModule[] = [
            ...MODULES,
            { key: 'AIOps', label: 'AI Ops', icon: null, navPath: '/app/agent', sortOrder: 20 },
        ];
        const ability = createMongoAbility([{ action: 'read', subject: 'Schedule' }]) as AppAbility;
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor(ability, { modules }) });

        // Inference says visible (no module owns this path)...
        expect(result.current.canSeeHref('/app/agent-ops')).toBe(true);
        // ...the explicit annotation correctly denies it.
        expect(result.current.canSeeModule('AIOps')).toBe(false);
    });
});

/**
 * ── THE REGRESSION THIS FILE PREVIOUSLY ENCODED RATHER THAN CAUGHT ──────────
 *
 * Nav gating originally asked `ability.can('read', moduleKey)`. No compiled rule
 * ever has a module key as its subject: the compiler expands a module-level
 * grant into one rule per SUBJECT of that module. Every test above passed only
 * because the fixtures granted `read Schedules` — a subject that does not exist
 * in the registry — so the tests agreed with the implementation about a world
 * neither shared with production.
 *
 * Live symptom: a role holding read + create on Schedules and Inventory saw
 * neither in the sidebar. Modules that happen to own a same-named subject
 * (Settings, Dashboard, AIOps) worked, which is what made it look intermittent,
 * and Owners never saw it at all because `manage all` matches every subject.
 */
describe('module visibility derives from SUBJECT grants, not the module key', () => {
    // Exactly what the compiler emits for a `read Schedules` module rule.
    const compiled = createMongoAbility([
        { action: 'read', subject: 'Schedule' },
        { action: 'read', subject: 'SpotGuard' },
    ]) as AppAbility;

    it('the module key is NOT a grantable subject — the false premise, pinned', () => {
        // If this ever becomes true the compiler has changed and canReadModule's
        // reason for existing should be re-examined.
        expect(compiled.can('read', 'Schedules' as never)).toBe(false);
    });

    it('still reports the module as visible', () => {
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor(compiled) });

        expect(result.current.canSeeModule('Schedules')).toBe(true);
        expect(result.current.canSeeHref('/app/schedules')).toBe(true);
    });

    it('one readable subject is enough — a module is not all-or-nothing', () => {
        const partial = createMongoAbility([{ action: 'read', subject: 'SpotGuard' }]) as AppAbility;
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor(partial) });

        expect(result.current.canSeeModule('Schedules')).toBe(true);
    });

    it('a module whose every subject is unreadable stays hidden', () => {
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor(compiled) });

        // Settings owns Settings + User; neither is granted.
        expect(result.current.canSeeModule('Settings')).toBe(false);
        expect(result.current.canSeeHref('/app/settings/members')).toBe(false);
    });

    it('a non-read grant does not open the module', () => {
        // `create Schedule` without `read Schedule` must not reveal the section:
        // the nav gate is specifically about reading.
        const writeOnly = createMongoAbility([{ action: 'create', subject: 'Schedule' }]) as AppAbility;
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor(writeOnly) });

        expect(result.current.canSeeModule('Schedules')).toBe(false);
    });

    it('useAccessibleModules follows the same derivation', () => {
        const { result } = renderHook(() => useAccessibleModules(), { wrapper: wrapperFor(compiled) });

        expect(result.current.map((m) => m.key)).toEqual(['Schedules']);
    });
});

// @vitest-environment jsdom
//
// Declared per-file rather than relying on vitest.config.ts's
// `environmentMatchGlobs` — that option was REMOVED in Vitest 4, so the config's
// `['**/__tests__/**/*.test.tsx', 'jsdom']` entry is inert and every component
// test under it runs in the `node` environment with no `document`. Matches the
// idiom in `use-can.test.tsx`.

import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createMongoAbility } from '@casl/ability';
import { AbilityProvider as CaslAbilityProvider } from '@casl/react';
import type { ReactNode } from 'react';

import { AbilityMetaContext, type AbilityMeta } from '@/providers/ability-provider';
import { useNavGate } from '@/hooks/use-can';

const META: AbilityMeta = {
    modules: [
        { key: 'AIOps', label: 'AI Ops', icon: null, navPath: '/app/agent', sortOrder: 40 },
        { key: 'Settings', label: 'Settings', icon: null, navPath: '/app/settings', sortOrder: 50 },
    ],
    actions: [],
    subjects: [
        { key: 'Agent', label: 'Agent', kind: 'resource', moduleKey: 'AIOps', navPath: '/app/agent', sortOrder: 10 },
        { key: 'Provider', label: 'Provider', kind: 'resource', moduleKey: 'AIOps', navPath: '/app/agent-ops/providers', sortOrder: 70 },
        { key: 'Skill', label: 'Skill', kind: 'resource', moduleKey: 'AIOps', navPath: '/app/skills', sortOrder: 60 },
        { key: 'Tenant', label: 'Tenant', kind: 'resource', moduleKey: 'Settings', navPath: '/app/settings/organization', sortOrder: 30 },
    ],
    moduleActions: [],
    actionAliases: {},
    version: '1.0',
    isLoaded: true,
};

function wrapperFor(rules: { action: string; subject: string; inverted?: boolean }[]) {
    const ability = createMongoAbility(rules as never);
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <CaslAbilityProvider value={ability as never}>
                <AbilityMetaContext.Provider value={META}>{children}</AbilityMetaContext.Provider>
            </CaslAbilityProvider>
        );
    };
}

describe('useNavGate', () => {
    it('hides a destination whose owning subject is denied', () => {
        // AIOps read everywhere EXCEPT Provider — exactly what the matrix writes
        // for "AI Ops: read, Provider: deny read".
        const { result } = renderHook(() => useNavGate(), {
            wrapper: wrapperFor([
                { action: 'read', subject: 'Agent' },
                { action: 'read', subject: 'Skill' },
            ]),
        });

        expect(result.current.canSeeHref('/app/skills')).toBe(true);
        expect(result.current.canSeeHref('/app/agent-ops/providers')).toBe(false);
    });

    it('keeps a module-owned destination visible when any subject is readable', () => {
        const { result } = renderHook(() => useNavGate(), {
            wrapper: wrapperFor([{ action: 'read', subject: 'Tenant' }]),
        });

        expect(result.current.canSeeHref('/app/settings/organization')).toBe(true);
    });

    it('leaves a destination no row claims visible', () => {
        const { result } = renderHook(() => useNavGate(), { wrapper: wrapperFor([]) });
        expect(result.current.canSeeHref('/app/nowhere')).toBe(true);
    });

    it('canSeeSubject answers directly', () => {
        const { result } = renderHook(() => useNavGate(), {
            wrapper: wrapperFor([{ action: 'read', subject: 'Provider' }]),
        });

        expect(result.current.canSeeSubject('Provider')).toBe(true);
        expect(result.current.canSeeSubject('Skill')).toBe(false);
    });

    it('canSeeSubject fails closed for an unknown subject', () => {
        const { result } = renderHook(() => useNavGate(), {
            wrapper: wrapperFor([{ action: 'manage', subject: 'all' }]),
        });

        expect(result.current.canSeeSubject('NotInRegistry')).toBe(false);
    });
});

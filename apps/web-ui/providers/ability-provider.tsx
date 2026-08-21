'use client';

/**
 * Client-side CASL ability, fetched from /api/me/ability.
 *
 * ── THE DEFAULT IS AN EMPTY ABILITY, DELIBERATELY ───────────────────────────
 * `createMongoAbility([])` denies everything. A page that renders before the
 * rules arrive therefore HIDES controls rather than flashing ones the user is
 * about to lose. The permissive default is the tempting one — it avoids a
 * flicker — and it turns every slow network into a UI leak, so it is not used.
 *
 * The ability instance is STABLE for the life of the provider: new rules arrive
 * via `ability.update()`, not by constructing a new object. `useAbility` from
 * @casl/react subscribes to that update and re-renders consumers in place, so
 * nothing below remounts when a permission changes.
 *
 * Server Components do NOT use this context — they read `getAbilityForSession()`
 * directly. Keeping the context strictly client-side sidesteps the hydration
 * problem that appears when CASL context is hoisted above the RSC boundary.
 */

import { createContext, useEffect, useMemo, type ReactNode } from 'react';
import { createMongoAbility } from '@casl/ability';
import { unpackRules } from '@casl/ability/extra';
import { AbilityProvider as CaslAbilityProvider, Can } from '@casl/react';
import { useQuery } from '@tanstack/react-query';
import type { AppAbility } from '@nucleus/rbac';

import { queryKeys } from '@/lib/queries/query-keys';
import type { AbilityModuleAction } from '@/lib/rbac/ability-payload';

export type { AbilityModuleAction };

/** A module as the sidebar needs it — same rows the rules compiled from. */
export interface AbilityModule {
    key: string;
    label: string;
    icon: string | null;
    navPath: string | null;
    sortOrder: number;
}

export interface AbilityActionDef {
    key: string;
    label: string;
    aliasOfKey: string | null;
    isDangerous: boolean;
}

export interface AbilitySubjectDef {
    key: string;
    label: string;
    kind: string;
    /**
     * The module this subject hangs off, or null if it is linked to none.
     *
     * Required for nav gating: compiled rules name SUBJECTS, never modules, so
     * "may this user see the Inventory section" can only be answered by asking
     * about Inventory's subjects. See the note in /api/me/ability.
     */
    moduleKey: string | null;
    /** Destination this subject owns, or null. Drives nav gating and the page guard. */
    navPath: string | null;
    /** Row order under its module in the permission matrix. */
    sortOrder: number;
}

interface AbilityPayload {
    rules: unknown[];
    version: string;
    modules: AbilityModule[];
    actions: AbilityActionDef[];
    subjects: AbilitySubjectDef[];
    moduleActions: AbilityModuleAction[];
}

/**
 * Declarative gating: `<Can I="delete" a="Schedule">…</Can>`.
 *
 * ── DIVERGENCE FROM THE PLAN, FORCED BY @casl/react v7 ──────────────────────
 * The plan (§12.2) spells this `createContextualCan(AbilityContext.Consumer)`
 * over a hand-rolled context. That is the v6 API and does not exist in v7:
 * `createContextualCan` was removed, `Can` reads the library's own context
 * directly, and `useAbility()` no longer takes a context argument. So the
 * ability travels through @casl/react's own `AbilityProvider` and only the
 * registry METADATA gets a context of ours. Same behaviour, current API.
 */
export { Can };

/**
 * Registry metadata that travels with the rules.
 *
 * Separate context so a component that only needs nav modules does not re-render
 * on every ability update, and vice versa.
 */
export interface AbilityMeta {
    modules: AbilityModule[];
    actions: AbilityActionDef[];
    subjects: AbilitySubjectDef[];
    moduleActions: AbilityModuleAction[];
    /** Alias verb -> terminal verb, so the client resolves aliases like the server. */
    actionAliases: Record<string, string>;
    version: string | null;
    /** False until the first successful fetch — lets callers show skeletons. */
    isLoaded: boolean;
}

export const AbilityMetaContext = createContext<AbilityMeta>({
    modules: [],
    actions: [],
    subjects: [],
    moduleActions: [],
    actionAliases: {},
    version: null,
    isLoaded: false,
});

export function AbilityProvider({ children }: { children: ReactNode }) {
    // One instance for the provider's lifetime — see the note above.
    const ability = useMemo(() => createMongoAbility([]) as AppAbility, []);

    const { data, isSuccess } = useQuery({
        queryKey: queryKeys.ability.me(),
        staleTime: 60_000,
        refetchOnWindowFocus: true,
        // A failed ability fetch must not retry forever behind an empty ability;
        // one retry covers a transient blip, and the empty default stays safe.
        retry: 1,
        queryFn: async (): Promise<AbilityPayload> => {
            const res = await fetch('/api/me/ability');
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to load permissions.');
            return json.data as AbilityPayload;
        },
    });

    // Keyed on `version`, not on `data`: the payload object identity changes on
    // every refetch, and re-running update() with identical rules would churn
    // every subscriber for nothing.
    const version = data?.version ?? null;
    useEffect(() => {
        if (!data) return;
        ability.update(unpackRules(data.rules as never) as never);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ability, version]);

    const meta = useMemo<AbilityMeta>(() => {
        const actions = data?.actions ?? [];
        const actionAliases: Record<string, string> = {};
        for (const action of actions) {
            if (action.aliasOfKey) actionAliases[action.key] = action.aliasOfKey;
        }
        return {
            modules: data?.modules ?? [],
            actions,
            subjects: data?.subjects ?? [],
            moduleActions: data?.moduleActions ?? [],
            actionAliases,
            version,
            isLoaded: isSuccess,
        };
    }, [data, version, isSuccess]);

    return (
        <CaslAbilityProvider value={ability}>
            <AbilityMetaContext.Provider value={meta}>{children}</AbilityMetaContext.Provider>
        </CaslAbilityProvider>
    );
}

'use client';

/**
 * Client-side permission hooks — thin wrappers over the CASL ability context.
 *
 * These are UX, not security. Hiding a button prevents a pointless 403; it does
 * not stop anyone, because the same person can call the API directly. The
 * boundary is `authorize()` on the route. Both exist by design (section 12.5).
 */

import { useContext, useMemo } from 'react';
import { useAbility } from '@casl/react';
import { createMongoAbility, subject as tagSubject } from '@casl/ability';
import { resolveNavOwner, type AppAbility } from '@nucleus/rbac';

import { AbilityMetaContext, type AbilityModule, type AbilityModuleAction } from '@/providers/ability-provider';

/**
 * The raw ability. Prefer `useCan` unless you need `relevantRuleFor`.
 *
 * @casl/react v7's `useAbility()` takes no context argument — it reads the
 * library's own provider. It does not return null when that provider is absent:
 * it THROWS ("AbilityContext is not provided"). So `ability ?? fallback` was
 * unreachable, and every consumer of these hooks crashed its whole subtree
 * instead of denying whenever it rendered outside the provider. An empty ability
 * is the correct answer there — denying everything is safe, and a missing
 * provider must never be able to turn a gated control into a blank page.
 *
 * ── WHY try/catch AROUND A HOOK IS SAFE HERE ────────────────────────────────
 * Normally it is not: a hook that throws part-way leaves the hook order
 * inconsistent between renders. useAbility() runs all of its own hooks
 * (useContext, two useCallbacks, useSyncExternalStore) BEFORE the throw, so the
 * number of hooks it registers is identical whether or not it throws. The order
 * is therefore stable across renders, which is the invariant that matters.
 */
export function useAppAbility(): AppAbility {
    const fallback = useMemo(() => createMongoAbility([]) as AppAbility, []);

    let ability: AppAbility | null = null;
    try {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        ability = useAbility<AppAbility>();
    } catch {
        ability = null;
    }

    return ability ?? fallback;
}

/** Registry metadata that shipped alongside the rules. */
export function useAbilityMeta() {
    return useContext(AbilityMetaContext);
}

/**
 * The (module, action) cells the role editor may offer. Sourced from the ability
 * payload so the grid and the compiler cannot disagree about which cells exist.
 */
export function useGrantableCells(): AbilityModuleAction[] {
    return useAbilityMeta().moduleActions;
}

/**
 * `useCan('delete', 'Schedule')` — or, for a conditional grant, pass the row:
 * `useCan('update', 'Schedule', schedule)`.
 *
 * ── PASS THE ROW WHENEVER YOU HAVE IT ───────────────────────────────────────
 * CASL evaluates conditions against a subject INSTANCE. Asked about a bare
 * subject name it answers "could this ever be allowed" and returns true, so a
 * conditionally-granted role would see an enabled button on every row including
 * the ones the API will refuse. Omit `data` only where no specific row exists
 * (a "New…" button, a nav entry).
 */
export function useCan(action: string, subjectType: string, data?: Record<string, unknown> | null): boolean {
    const ability = useAppAbility();
    const { actionAliases } = useAbilityMeta();

    // Rules are compiled with TERMINAL verbs, so an aliased verb must be
    // translated before it reaches CASL — same resolution the server does.
    const resolved = actionAliases[action] ?? action;
    const target = data ? (tagSubject(subjectType, { ...data }) as never) : (subjectType as never);

    return ability.can(resolved, target);
}

/** Inverse of `useCan`, for readability at call sites that gate on absence. */
export function useCannot(action: string, subjectType: string, data?: Record<string, unknown> | null): boolean {
    return !useCan(action, subjectType, data);
}

/**
 * Can this user read ANYTHING in the given module?
 *
 * ── WHY THIS IS NOT `ability.can('read', moduleKey)` ────────────────────────
 * That was the original premise here, and it was false. The rule compiler
 * expands a module-level grant into ONE RULE PER SUBJECT of that module and
 * never emits a rule whose subject is the module key (rule-compiler.ts, step 2).
 * So `can('read', 'Inventory')` is false even for a role granted `read
 * Inventory` outright — the compiled rules say `read Resource`, `read Tag`, and
 * so on.
 *
 * The visible symptom was a sidebar that hid Inventory and Cost Scheduler from a
 * role holding read+create on both, while every entry whose href matched no
 * module stayed visible through the fail-open fallback. Owners were unaffected
 * because `manage all` matches any subject, which is why this survived review.
 *
 * A module with no subjects linked to it is treated as readable-if-granted via
 * its own key, preserving the "add a module row, get a sidebar entry" property
 * for a module whose subjects have not been declared yet.
 */
function canReadModule(
    ability: AppAbility,
    subjects: { key: string; moduleKey: string | null }[],
    moduleKey: string
): boolean {
    const owned = subjects.filter((s) => s.moduleKey === moduleKey);
    if (owned.length === 0) return ability.can('read', moduleKey as never);
    return owned.some((s) => ability.can('read', s.key as never));
}

/**
 * The modules this user may see, in nav order.
 *
 * Modules without a `navPath` are real modules that simply have no destination,
 * so they are excluded here rather than rendered dead.
 */
export function useAccessibleModules(): AbilityModule[] {
    const ability = useAppAbility();
    const { modules, subjects } = useAbilityMeta();

    return modules.filter((m) => Boolean(m.navPath) && canReadModule(ability, subjects, m.key));
}

/**
 * Nav gating, driven by `navPath` + read grants.
 *
 * Resolution is the SHARED resolver from @nucleus/rbac, the same one the
 * middleware page guard uses — a sidebar that hides a link the page still serves
 * (or the reverse) is a bug that only surfaces in production, so the logic is
 * imported rather than reimplemented.
 *
 * ── A DESTINATION NO ROW CLAIMS STAYS VISIBLE ───────────────────────────────
 * Deliberate. Nav is UX; page admission and `authorize()` are the boundary.
 * Failing closed here would blank the sidebar for any route the registry has not
 * been taught about yet — a missing metadata row would look like an outage —
 * while failing open costs at most one avoidable 403 on a route that is still
 * guarded server-side.
 *
 * `isLoaded` is false until the rules arrive. Callers render nothing gated until
 * then: the default ability is empty, so "not yet loaded" behaves as denied, and
 * showing the full nav first would flash entries the user is about to lose.
 */
export function useNavGate(): {
    isLoaded: boolean;
    canSeeHref: (href: string) => boolean;
    canSeeModule: (moduleKey: string) => boolean;
    canSeeSubject: (subjectKey: string) => boolean;
} {
    const ability = useAppAbility();
    const { modules, subjects, isLoaded } = useAbilityMeta();

    /**
     * A module absent from the registry is NOT visible — the opposite of
     * canSeeHref's fallback, and deliberately so: an unmatched HREF usually means
     * "this route belongs to no module", whereas an unmatched MODULE KEY means
     * the annotation is wrong or the module was retired.
     */
    const canSeeModule = (moduleKey: string): boolean => {
        const known = modules.some((m) => m.key === moduleKey);
        if (!known) return false;
        return canReadModule(ability, subjects, moduleKey);
    };

    /** Same fail-closed reasoning as canSeeModule: an unknown key is a bad annotation. */
    const canSeeSubject = (subjectKey: string): boolean => {
        const known = subjects.some((s) => s.key === subjectKey);
        if (!known) return false;
        return ability.can('read', subjectKey as never);
    };

    const canSeeHref = (href: string): boolean => {
        const owner = resolveNavOwner(href, subjects, modules);
        if (!owner) return true;
        return owner.kind === 'subject'
            ? ability.can('read', owner.key as never)
            : canReadModule(ability, subjects, owner.key);
    };

    return { isLoaded, canSeeHref, canSeeModule, canSeeSubject };
}

/**
 * Why an action is unavailable, for a tooltip — the reason attached to the
 * matched rule when there is one, otherwise a generic line.
 *
 * Returns null when the action IS allowed, so a caller can write:
 *   const reason = useDenialReason('delete', 'Schedule', row);
 */
export function useDenialReason(
    action: string,
    subjectType: string,
    data?: Record<string, unknown> | null
): string | null {
    const ability = useAppAbility();
    const { actionAliases } = useAbilityMeta();

    const resolved = actionAliases[action] ?? action;
    const target = data ? (tagSubject(subjectType, { ...data }) as never) : (subjectType as never);

    if (ability.can(resolved, target)) return null;

    // relevantRuleFor() answers "which rule decided this" — and when a
    // CONDITIONAL `can` rule simply fails to match the row, the answer is
    // nothing at all: the denial comes from the absence of a matching rule, not
    // from a rule. So the reason attached to that near-miss grant ("Restricted
    // to your assigned accounts") is invisible here, which is exactly the reason
    // most worth showing the user.
    //
    // Look for it among the rules that COULD have applied to this action and
    // subject. rulesFor() ignores conditions, so a conditional grant the row
    // missed still turns up.
    const relevant = ability.relevantRuleFor(resolved, target);
    if (relevant?.reason) return relevant.reason;

    const nearMiss = ability
        .rulesFor(resolved, subjectType)
        .find((r) => !r.inverted && r.conditions && r.reason);

    return nearMiss?.reason ?? `You do not have permission to ${action} ${subjectType}.`;
}

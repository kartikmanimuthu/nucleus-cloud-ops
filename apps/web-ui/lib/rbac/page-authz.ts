/**
 * Page admission — the chrome-level twin of route-authz.ts.
 *
 * ── DELIBERATE DIVERGENCE FROM LAYER 1's FAIL-CLOSED CONTRACT ───────────────
 * A DENIAL fails closed. An INFRASTRUCTURE failure (registry unreadable, the
 * compiler throwing) fails OPEN, logged at error.
 *
 * Layer 1 guards the DATA and must never serve a row it could not authorize.
 * This guard covers pages whose every API call is already gated twice, by Layer
 * 1 and by authorize(). A compiler outage should therefore degrade to
 * empty-looking pages, not lock every user out of the entire application.
 *
 * This is the OPPOSITE of enforceLayer1. Do not "fix" it to match.
 */

import type { AppAbility, NavOwner } from '@nucleus/rbac';

export type PageGuardMode = 'off' | 'shadow' | 'enforce';

/**
 * Default `shadow`, matching RBAC_ROUTE_GUARD_MODE. Turning a new guard on must
 * never be the thing that breaks prod; infra/compute sets `enforce` explicitly.
 */
export function pageGuardMode(): PageGuardMode {
    const raw = process.env.RBAC_PAGE_GUARD_MODE;
    return raw === 'enforce' || raw === 'off' ? raw : 'shadow';
}

/** Where a denial sends the user. Must itself be exempt, or it redirects forever. */
export const UNAUTHORIZED_PATH = '/app/unauthorized';

const EXEMPT = new Set(['/app', UNAUTHORIZED_PATH]);

export function isExemptPath(pathname: string): boolean {
    return EXEMPT.has(pathname);
}

/** The subset of a registry snapshot this module needs. */
export interface PageAuthzRegistry {
    subjects: { id: string; key: string; moduleKey: string | null }[];
}

/**
 * Whether the caller may READ the row that owns this page.
 *
 * A module owner is asked as "can you read ANY subject of this module", because
 * the compiler expands a module grant into one rule per subject and never emits
 * a rule whose subject is the module key — `can('read', 'Inventory')` is false
 * even for a role granted Inventory outright.
 */
export function canReadOwner(
    ability: AppAbility,
    owner: NavOwner,
    registry: PageAuthzRegistry
): boolean {
    if (owner.kind === 'subject') return ability.can('read', owner.key as never);

    const owned = registry.subjects.filter((s) => s.moduleKey === owner.key);
    if (owned.length === 0) return ability.can('read', owner.key as never);
    return owned.some((s) => ability.can('read', s.key as never));
}

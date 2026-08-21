/**
 * GET /api/me/ability — the caller's compiled rules, for the client bundle.
 *
 * This is the ONLY way rules reach the browser. It ships the same compiled
 * output the server authorizes with, so a control the UI shows and a route the
 * API allows can never disagree about which rules are in play — they are the
 * same array, packed.
 *
 * `modules` rides along because nav gating and the role grid must render from
 * the source the rules compiled FROM: a new module with a navPath appears in the
 * sidebar for roles that can read it with no deploy (section 12.1).
 *
 * Cache-Control is `private, no-store`. These rules are per-user and a shared
 * cache holding one user's grants and serving them to another is the whole
 * authorization model defeated.
 */

import { NextResponse } from 'next/server';
import { packRules } from '@casl/ability/extra';

import { getAbilityForSession } from '@/lib/rbac/session-ability';
import { loadRegistrySnapshot } from '@/lib/rbac/registry';
import { toAbilityModuleActions } from '@/lib/rbac/ability-payload';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const session = await getAbilityForSession();

        if (!session) {
            return NextResponse.json(
                { success: false, error: 'Unauthenticated' },
                { status: 401, headers: { 'Cache-Control': 'private, no-store' } }
            );
        }

        const { ability, version, principal, dropped } = session;

        if (dropped.length > 0) {
            // Same signal the server logs on evaluate — a dropped rule is a
            // permission that mysteriously does not work, and the client would
            // otherwise show it as simply absent.
            console.error('[rbac] rules dropped while serving /api/me/ability:', JSON.stringify(dropped));
        }

        const registry = await loadRegistrySnapshot(principal.tenantId);
        const moduleKeyById = new Map(registry.modules.map((m) => [m.id, m.key]));

        return NextResponse.json(
            {
                success: true,
                data: {
                    // packRules strips the rules to their wire form. unpackRules on
                    // the client is the exact inverse.
                    rules: packRules(ability.rules as never),
                    version,
                    // Disabled modules are omitted rather than sent with a flag:
                    // the compiler already contributes nothing for them, so a nav
                    // entry driven off this list cannot show a dead destination.
                    modules: registry.modules
                        .filter((m) => m.enabled)
                        .map((m) => ({
                            key: m.key,
                            label: m.label,
                            icon: m.icon,
                            navPath: m.navPath,
                            sortOrder: m.sortOrder,
                        }))
                        .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key)),
                    actions: registry.actions.map((a) => ({
                        key: a.key,
                        label: a.label,
                        aliasOfKey: a.aliasOfKey,
                        isDangerous: a.isDangerous,
                    })),
                    /**
                     * Which grid cells exist. Rides along for the same reason
                     * `modules` does: the role editor must render from the rows
                     * the rules compiled FROM, or a tick and a grant can differ.
                     */
                    moduleActions: toAbilityModuleActions(registry),
                    /**
                     * `moduleKey` is what makes nav gating possible at all.
                     *
                     * The compiler expands a MODULE-level rule into one rule per
                     * SUBJECT of that module (see rule-compiler.ts step 2) and
                     * never emits a rule whose subject is the module key. So
                     * `ability.can('read', 'Inventory')` is always false, and any
                     * client check written that way hides the entry from everyone
                     * who is not an Owner (Owners match via `manage all`).
                     * Shipping the link lets the client ask the question the rules
                     * can actually answer: "can you read anything in here?".
                     */
                    subjects: registry.subjects.map((s) => ({
                        key: s.key,
                        label: s.label,
                        kind: s.kind,
                        navPath: s.navPath,
                        sortOrder: s.sortOrder,
                        moduleKey:
                            moduleKeyById.get(
                                registry.subjectModules.find((link) => link.subjectId === s.id)?.moduleId ?? ''
                            ) ?? null,
                    })),
                },
            },
            { headers: { 'Cache-Control': 'private, no-store' } }
        );
    } catch (error) {
        console.error('API - Error building ability payload:', error);
        // Fail closed: no rules rather than a stale or partial set. The client's
        // default ability is empty, so this hides controls instead of showing
        // ones the API would refuse.
        return NextResponse.json(
            { success: false, error: 'Failed to load ability' },
            { status: 500, headers: { 'Cache-Control': 'private, no-store' } }
        );
    }
}

/**
 * Comparable grant keys for the parity harness.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * parity-live.test.ts compared two flat string sets: the legacy matrix's
 * `Module:action` keys against the compiled rules' `coalesce(module.key,
 * subject.key):action`. Those key spaces are not the same space. A
 * subject-targeted rule emitted `Agent:read`, the legacy matrix said
 * `AIOps:read`, and the suite reported an over-grant for every role in the
 * database even though SUBJECT_TO_MODULE maps Agent onto AIOps and the grants
 * were identical.
 *
 * Worse than a red suite: once the comparison produces six known-benign
 * failures, a genuine privilege escalation hides in the same noise.
 *
 * ── WHY EXACT SET EQUALITY IS THE WRONG INVARIANT NOW ───────────────────────
 * `LegacyModule` is a closed union of six modules. The registry is now
 * admin-authored and holds more (a tenant created `TampModule` through the
 * Access Control UI). A grant on a seventh module cannot be expressed in a
 * Record<LegacyModule, Action[]> at all, so "legacy ≡ CASL" is unsatisfiable
 * by construction, not because anything is wrong.
 *
 * So the comparison is scoped: WITHIN the six legacy modules the two engines
 * must agree exactly. Grants outside that taxonomy are returned separately in
 * `outOfScope` so the caller can report them — excluding them silently would
 * let the gate quietly stop covering things.
 *
 * Pure and synchronous by design: the live suite supplies the rows, this file
 * decides what they mean, and the decision is unit-testable offline. Deleted in
 * Workstream J along with the legacy matrix and the rest of the harness.
 */

import type { LegacyModule } from './types';

/**
 * Exhaustive both ways: a key that is not a LegacyModule fails to typecheck,
 * and a LegacyModule that is missing from the literal fails to typecheck. A
 * plain array would catch only the first.
 */
const LEGACY_MODULE_PRESENCE: Record<LegacyModule, true> = {
    Accounts: true,
    Schedules: true,
    AIOps: true,
    Inventory: true,
    Settings: true,
    Dashboard: true,
    IAM: true,
};

export const LEGACY_MODULES = Object.keys(LEGACY_MODULE_PRESENCE) as LegacyModule[];

const LEGACY_MODULE_SET = new Set<string>(LEGACY_MODULES);

/** One compiled grant, before its target is normalised. */
export interface RuleTarget {
    action: string;
    /** Set for a module-level grant. */
    moduleKey: string | null;
    /** Set for a subject-level grant. Exactly one of the two is non-null. */
    subjectKey: string | null;
    /** Inverted rules are denials; they are not grants and are skipped. */
    inverted: boolean;
}

/** A row of the subject → module mapping, global (`tenantId: null`) or tenant-local. */
export interface SubjectModuleRow {
    subjectKey: string;
    moduleKey: string;
    tenantId: string | null;
}

export interface NormalizedGrants {
    /** `Module:action` keys inside the legacy taxonomy — the comparable set. */
    inScope: Set<string>;
    /** `Module:action` keys outside it. Reported, never compared. */
    outOfScope: string[];
    /** Subject keys with no module link. A silent drop here would hide a grant. */
    unmappedSubjects: string[];
}

/**
 * Subject key → owning module key.
 *
 * A tenant-local link shadows the global link for the same subject, matching
 * mergeBySubjectId() in registry-admin.ts: a remap writes a tenant-local row
 * while the global row survives (mutating the global row would move the subject
 * for every tenant), so both are visible and precedence must be explicit.
 * Resolved here in JS rather than by SQL ordering — Postgres sorts DESC with
 * NULLS FIRST, so "take the first match" would pick exactly backwards.
 */
export function resolveSubjectModuleMap(rows: SubjectModuleRow[]): Record<string, string> {
    const bySubject = new Map<string, SubjectModuleRow>();

    for (const row of rows) {
        const existing = bySubject.get(row.subjectKey);
        if (!existing || (existing.tenantId === null && row.tenantId !== null)) {
            bySubject.set(row.subjectKey, row);
        }
    }

    return Object.fromEntries([...bySubject].map(([subjectKey, row]) => [subjectKey, row.moduleKey]));
}

/** Splits `Module:action` on the FIRST colon, so an action may contain one. */
function moduleOf(key: string): string {
    const index = key.indexOf(':');
    return index === -1 ? key : key.slice(0, index);
}

/**
 * Turns raw rule targets into comparable keys.
 *
 * A subject-level rule is rewritten onto its owning module, which is what makes
 * `Agent:read` and `AIOps:read` compare equal. Both are the same grant to the
 * legacy matrix, because SUBJECT_TO_MODULE resolves the subject to the module
 * before checking.
 */
export function normalizeGrants(
    rules: RuleTarget[],
    moduleKeyBySubjectKey: Record<string, string>
): NormalizedGrants {
    const inScope = new Set<string>();
    const outOfScope = new Set<string>();
    const unmappedSubjects = new Set<string>();

    for (const rule of rules) {
        if (rule.inverted) continue;

        let moduleKey = rule.moduleKey;

        if (!moduleKey && rule.subjectKey) {
            const owning = moduleKeyBySubjectKey[rule.subjectKey];
            if (!owning) {
                unmappedSubjects.add(rule.subjectKey);
                continue;
            }
            moduleKey = owning;
        }

        // Neither a module nor a subject: the DB CHECK makes this unreachable,
        // and there is nothing to compare, so skip rather than invent a key.
        if (!moduleKey) continue;

        const key = `${moduleKey}:${rule.action}`;
        if (LEGACY_MODULE_SET.has(moduleKey)) inScope.add(key);
        else outOfScope.add(key);
    }

    return {
        inScope,
        outOfScope: [...outOfScope].sort(),
        unmappedSubjects: [...unmappedSubjects].sort(),
    };
}

/**
 * Restricts already-module-keyed grants (the legacy side) to the legacy
 * taxonomy. A custom role's stored JSON may name a tenant-authored module,
 * which has no place in the comparison.
 */
export function filterToLegacyModules(keys: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const key of keys) {
        if (LEGACY_MODULE_SET.has(moduleOf(key))) out.add(key);
    }
    return out;
}

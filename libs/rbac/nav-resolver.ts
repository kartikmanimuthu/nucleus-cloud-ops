/**
 * Resolves a destination to the registry row that gates it.
 *
 * ── WHY THIS LIVES IN libs/rbac AND NOT IN THE HOOK ─────────────────────────
 * Two callers must agree exactly: the sidebar (which decides whether to render
 * a link) and the middleware page guard (which decides whether to serve the
 * page). If they disagree, the user gets either a visible link that redirects
 * or an invisible page that works. Both are bugs that only show up in
 * production, so the logic is written once and imported twice rather than
 * implemented twice.
 */

/** A registry row that may own a destination. */
export interface NavPathRow {
    key: string;
    navPath: string | null;
}

export interface NavOwner {
    kind: 'subject' | 'module';
    key: string;
    navPath: string;
}

/**
 * `/app/agent-ops` must NOT match navPath `/app/agent`. Requiring the separator
 * is the whole defence — without it every sibling route whose name merely starts
 * with another's is silently swallowed by it.
 */
function claims(pathname: string, navPath: string): boolean {
    return pathname === navPath || pathname.startsWith(`${navPath}/`);
}

/**
 * The owner of `pathname`: longest matching navPath across subjects ∪ modules.
 *
 * A SUBJECT beats a MODULE at equal length, because a subject is the strictly
 * more specific claim. This tie-break is load-bearing: module AIOps and subject
 * Agent both sit on '/app/agent'.
 *
 * Returns null when nothing claims the path. Callers treat that as visible —
 * nav is UX and the API underneath is guarded independently, so failing closed
 * here would turn a missing metadata row into an apparent outage.
 */
export function resolveNavOwner(
    pathname: string,
    subjects: NavPathRow[],
    modules: NavPathRow[]
): NavOwner | null {
    const candidates: NavOwner[] = [];

    for (const subject of subjects) {
        if (subject.navPath && claims(pathname, subject.navPath)) {
            candidates.push({ kind: 'subject', key: subject.key, navPath: subject.navPath });
        }
    }
    for (const module of modules) {
        if (module.navPath && claims(pathname, module.navPath)) {
            candidates.push({ kind: 'module', key: module.key, navPath: module.navPath });
        }
    }

    if (candidates.length === 0) return null;

    // Longest navPath, then subject-over-module, then key order. The last clause
    // exists only so a misconfigured registry (two rows on one navPath) resolves
    // the SAME way on every process rather than following row order — Postgres
    // makes no ordering promise. assert-subject-coverage.ts rejects that state
    // outright; this keeps it deterministic until someone runs the check.
    candidates.sort((a, b) => {
        if (a.navPath.length !== b.navPath.length) return b.navPath.length - a.navPath.length;
        if (a.kind !== b.kind) return a.kind === 'subject' ? -1 : 1;
        return a.key.localeCompare(b.key);
    });

    return candidates[0];
}

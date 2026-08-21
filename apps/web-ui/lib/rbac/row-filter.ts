/**
 * Gate 3 entry point for API routes: "which rows may the CURRENT caller read".
 *
 * A list route calls this once, passes the result down through its service to
 * its repository, and the repository intersects it with the query it was already
 * building (`andWhere()` in lib/db/pg-config.ts). Routes never touch Prisma
 * themselves, so the filter travels as data through the existing layers rather
 * than as a second query path beside them.
 *
 * @example
 * const rowFilter = await getReadRowFilter('Schedule');
 * const { schedules, total } = await ScheduleService.getSchedules({ tenantId, rowFilter });
 */

import type { PrismaRowFilter } from '@/lib/db/pg-config';

import { readFilterFor, UntranslatableFilterError } from './prisma-filter';
import { getAbilityForSession } from './session-ability';

/**
 * Mirrors authorize.ts. During the shadow period the LEGACY matrix decides, and
 * the legacy matrix has no conditions at all — so enforcing a CASL row filter
 * now would narrow result sets that the deciding engine still considers fully
 * visible. That is a silent data-loss regression dressed as a security fix.
 *
 * So the filter is computed either way (to surface translation faults early) but
 * only APPLIED once CASL is the decision source. Removed in Workstream J with
 * the rest of the flag.
 */
function dynamicAbacEnabled(): boolean {
    return process.env.DYNAMIC_ABAC_ENABLED === 'true';
}

/**
 * The Prisma `where` fragment restricting a list to the caller's readable rows,
 * or `null` when no narrowing applies.
 *
 * `null` means "add nothing", NOT "allow everything": the tenant predicate is
 * still injected by getTenantClient(), and whether the caller may run the list
 * at all was already settled by `authorize('read', subject)` upstream. This
 * function only ever narrows.
 *
 * Fail-closed contract (section 8.7): an unauthenticated caller and an
 * untranslatable rule both refuse rather than degrade. The former returns a
 * deny-all filter, because reaching here without a session while Gate 2 is
 * enforcing means something upstream is wrong and an empty list is the safe
 * answer. The latter throws, so the route 500s loudly instead of quietly showing
 * the wrong rows.
 *
 * @throws UntranslatableFilterError
 */
export async function getReadRowFilter(subjectType: string): Promise<PrismaRowFilter | null> {
    const session = await getAbilityForSession();

    if (!session) {
        if (!dynamicAbacEnabled()) return null;
        console.error(`[rbac] rbac.row_filter.no_session subject=${subjectType} — denying all rows`);
        return { OR: [] };
    }

    // SuperAdmin compiles to `manage all`, which accessibleBy() reduces to `{}`
    // anyway; short-circuiting keeps that explicit and skips the walk.
    if (session.principal.isSuperAdmin) return null;

    let filter: PrismaRowFilter;
    try {
        filter = readFilterFor(session.ability, subjectType);
    } catch (error) {
        if (error instanceof UntranslatableFilterError) {
            console.error('[rbac] rbac.row_filter.untranslatable', error.message);
        }
        // Only enforcing mode may fail the request. In shadow mode the legacy
        // matrix is deciding and a translation fault must not take the route
        // down — it is logged above and the request proceeds unfiltered.
        if (dynamicAbacEnabled()) throw error;
        return null;
    }

    if (!dynamicAbacEnabled()) {
        if (Object.keys(filter).length > 0) {
            // The pre-flip signal, matching rbac.parity.mismatch: this is a list
            // whose result set WILL shrink at cutover.
            console.warn(
                '[rbac] rbac.row_filter.shadow',
                JSON.stringify({ subject: subjectType, filter, role: session.principal.roleName })
            );
        }
        return null;
    }

    return Object.keys(filter).length === 0 ? null : filter;
}

/**
 * Denial recording.
 *
 * The purpose is operational, not forensic: the admin UI aggregates the top
 * denied (action, subject) pairs per role so an administrator can see "your Ops
 * role is being denied `execute Schedule` 40 times a day" and fix the role,
 * rather than users filing tickets one at a time.
 *
 * Denials are the HIGH-VOLUME stream in this feature (the rule-change ledger is
 * low-volume by comparison), and a client in a retry loop can generate them
 * without bound. So: log every denial up to a per-tenant cap within a window,
 * then fall back to 1-in-N sampling. Losing exact counts is fine; flooding the
 * audit table is not.
 */

import { AuditService } from '@/lib/audit-service';

/** Denials logged in full per tenant per window before sampling kicks in. */
const CAP_PER_WINDOW = 50;
const WINDOW_MS = 60_000;
/** Above the cap, keep 1 in N. */
const SAMPLE_RATE = 20;

interface Bucket {
    count: number;
    windowStart: number;
}

const buckets = new Map<string, Bucket>();

/** @returns whether this denial should be written, and how many it stands for. */
function shouldRecord(tenantId: string): { record: boolean; weight: number } {
    const now = Date.now();
    const bucket = buckets.get(tenantId);

    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
        buckets.set(tenantId, { count: 1, windowStart: now });
        return { record: true, weight: 1 };
    }

    bucket.count += 1;

    if (bucket.count <= CAP_PER_WINDOW) return { record: true, weight: 1 };
    if (bucket.count % SAMPLE_RATE === 0) return { record: true, weight: SAMPLE_RATE };
    return { record: false, weight: 0 };
}

export interface DenialContext {
    userId: string;
    email: string;
    tenantId: string;
    roleName: string;
    action: string;
    subject: string;
    /** The rule that produced the denial, when CASL matched one. */
    reason?: string;
    route?: string;
    method?: string;
}

/**
 * Records an authorization denial. Never throws — a failure to audit must not
 * turn a clean 403 into a 500.
 */
export async function recordDenial(context: DenialContext): Promise<void> {
    try {
        const { record, weight } = shouldRecord(context.tenantId);
        if (!record) return;

        await AuditService.logUserAction({
            action: 'rbac.access.denied',
            resourceType: context.subject,
            resourceId: `${context.action}:${context.subject}`,
            resourceName: `${context.action} ${context.subject}`,
            user: context.email || context.userId,
            userType: 'user',
            status: 'warning',
            details:
                `Denied '${context.action}' on '${context.subject}' for role '${context.roleName}'` +
                (context.reason ? ` — ${context.reason}` : ''),
            tenantId: context.tenantId,
            eventType: 'authorization',
            severity: 'low',
            apiRoute: context.route,
            httpMethod: context.method,
            metadata: {
                rbacAction: context.action,
                rbacSubject: context.subject,
                role: context.roleName,
                matchedRuleReason: context.reason ?? null,
                // >1 means this row stands for `weight` denials that were sampled out.
                sampleWeight: weight,
            },
        });
    } catch (error) {
        console.error('[rbac] failed to record denial (continuing):', error);
    }
}

/** Test seam. */
export function resetDenialBuckets(): void {
    buckets.clear();
}

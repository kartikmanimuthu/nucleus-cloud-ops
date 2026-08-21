import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionTenantId } from '@/lib/auth-session';
import { sendSpotGuardSlackAlert } from '@/lib/spot-guard/notify';
import { env } from '@/env';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    POST: { action: 'update', subject: 'SpotGuard' },
};

/**
 * Internal relay: workers -> web-ui -> Slack.
 *
 * The workers process cannot import `@/lib/...` (separate npm package), and the per-tenant
 * Slack credentials plus config-shape logic live in web-ui. Rather than duplicating secret
 * handling in the worker, the worker POSTs here — the same pattern the agent-ops scheduler
 * already uses for its scheduled-task trigger.
 */

/**
 * Resolve tenantId from either the internal worker header or a session.
 *
 * The internal path authenticates ONLY when INTERNAL_API_KEY is configured AND matches.
 * There is deliberately no hardcoded fallback: a default like 'internal-worker-key' would
 * let anyone able to reach this service post arbitrary messages into any tenant's Slack. If
 * the env var is unset the internal branch never matches and we fall through to session
 * auth — fail closed. Copied from
 * app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts.
 */
async function resolveTenantId(req: Request): Promise<string> {
    const internalKey = req.headers.get('x-internal-key');
    if (env.INTERNAL_API_KEY && internalKey === env.INTERNAL_API_KEY) {
        const tenantId = req.headers.get('x-tenant-id');
        if (!tenantId) throw new Error('x-tenant-id header required for internal calls');
        return tenantId;
    }
    return getSessionTenantId();
}

const NotifySchema = z.object({
    text: z.string().min(1).max(4000),
    color: z.string().optional(),
    channelId: z.string().optional(),
    // Presentation is composed in web-ui (lib/spot-guard/notify.ts) from these facts, rather than
    // sentence-built in the workers, so every alert comes out the same shape.
    layout: z.enum(['alert', 'digest']).optional(),
    eventType: z.string().optional(),
    serviceName: z.string().optional(),
    accountId: z.string().optional(),
    region: z.string().optional(),
    clusterName: z.string().optional(),
    fromCapacity: z.string().nullable().optional(),
    toCapacity: z.string().nullable().optional(),
});

export async function POST(req: Request) {
    try {
        const tenantId = await resolveTenantId(req);
        const parsed = NotifySchema.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) {
            // Zod 4 → .issues
            return NextResponse.json(
                { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
                { status: 400 },
            );
        }

        const { text, color, channelId, layout, ...ctx } = parsed.data;
        const result = await sendSpotGuardSlackAlert({
            tenantId,
            text,
            color,
            channelId,
            layout,
            // Flat on the wire, nested here — the composer takes one object so it can decide
            // between the compact shape and plain text from a single argument.
            context: ctx,
        });

        // 200 even when delivery did not happen: "this tenant has no Slack configured" is a
        // normal, expected outcome, not a server error. The worker records the reason on the
        // event row so the UI can show that Slack was skipped and why — a non-2xx here would
        // instead make pg-boss retry a remediation job that already completed.
        return NextResponse.json({ success: true, data: result });
    } catch (error: unknown) {
        console.error('API - Error sending spot-guard notification:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to send notification' },
            { status: 500 },
        );
    }
}

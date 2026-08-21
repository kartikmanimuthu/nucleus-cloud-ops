import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';
import { authorize } from '@/lib/rbac/authorize';

// Backward-compat redirect — API clients may still use this path.
// Remove once all clients are updated to /api/v1/gateway/api.
export async function POST(req: NextRequest) {
    /**
     * ── WHY THIS ROUTE NEEDS AN EXPLICIT CHECK ──────────────────────────────
     * `/api/v1/trigger/:path*` is allowlisted out of the route guard because
     * "each adapter verifies its own signature or shared secret … and none can
     * carry a session cookie" (lib/rbac/rbac-allowlist.ts). That premise does
     * NOT hold for the `api` channel: ApiAdapter.validateRequest accepts a bare
     * session cookie as sufficient, and parseInbound resolves the tenant from
     * the session for the "UI-driven flow". So a browser request reached
     * handleInbound and started an agent run with no permission check at all —
     * the sibling `/api/v1/gateway/api` declares { POST: create Agent }, and this
     * alias reaches the same handler without it.
     *
     * The check is conditional on a session so genuine external callers are
     * unaffected: they authenticate with `x-api-key` or `Authorization` and have
     * no session for authorize() to evaluate. A cookie-bearing caller, by
     * contrast, is a signed-in member and must hold `create Agent` like everyone
     * else.
     */
    const hasSession =
        req.cookies?.get('next-auth.session-token') ??
        req.cookies?.get('__Secure-next-auth.session-token');

    if (hasSession && !req.headers.get('x-api-key') && !req.headers.get('authorization')) {
        const authError = await authorize('create', 'Agent');
        if (authError) return authError;
    }

    return getGatewayService().handleInbound('api', req);
}

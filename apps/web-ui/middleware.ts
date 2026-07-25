import { withAuth, NextRequestWithAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
    function middleware(req: NextRequestWithAuth) {
        const token = req.nextauth.token;
        const { pathname } = req.nextUrl;

        // Guard /admin routes — super admin only (per AUTH-06, D-09)
        if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
            if (token?.isSuperAdmin !== true) {
                return NextResponse.json(
                    { error: "Forbidden", message: "Super admin access required" },
                    { status: 403 }
                );
            }
        }

        // No-tenant redirect — authenticated users without tenantId must create org (per D-05)
        // Skip for: /create-org itself, /api routes, /login, /signup, public routes
        const skipNoTenantRedirect =
            pathname === "/create-org" ||
            pathname.startsWith("/api/") ||
            pathname === "/login" ||
            pathname === "/signup" ||
            pathname === "/" ||
            pathname.startsWith("/docs");

        if (!skipNoTenantRedirect && token && !token.tenantId) {
            const createOrgUrl = new URL("/create-org", req.url);
            return NextResponse.redirect(createOrgUrl);
        }

        // Inject x-tenant-id header for downstream API routes (per AUTH-07)
        const requestHeaders = new Headers(req.headers);
        if (token?.tenantId) {
            requestHeaders.set("x-tenant-id", token.tenantId as string);
        }

        return NextResponse.next({
            request: { headers: requestHeaders },
        });
    },
    {
        callbacks: {
            authorized: ({ token, req }) => {
                const { pathname } = req.nextUrl;
                // Internal worker -> web-ui call: the agent-ops scheduler triggers a
                // scheduled task with a shared x-internal-key instead of a NextAuth
                // session. Let it past the auth gate; the route's resolveTenantId still
                // strictly validates the secret (and falls back to session auth if it
                // does not match). Mirrors the api/v1/trigger matcher exemption.
                if (
                    pathname.startsWith("/api/agent-ops/scheduled-tasks/") &&
                    pathname.endsWith("/trigger") &&
                    req.headers.get("x-internal-key")
                ) {
                    return true;
                }
                // Public routes — no auth required
                if (
                    pathname === "/login" ||
                    pathname === "/signup" ||
                    pathname === "/" ||
                    pathname.startsWith("/docs")
                ) {
                    return true;
                }
                return !!token;
            },
        },
    }
);

// Only the externally-signed webhook channels are exempted from the NextAuth gate —
// each verifies its own signature/secret in the adapter's validateRequest (Telegram's
// X-Telegram-Bot-Api-Secret-Token, Slack's HMAC signature, Discord's Ed25519, Jira's
// shared secret), and none of them can carry a session cookie.
//
// Deliberately NOT exempted: api/v1/gateway/api and api/v1/gateway/stream. Those are
// session-authenticated UI paths — ApiAdapter.validateRequest accepts ANY Authorization
// or x-api-key header without validating it, and this middleware is what overwrites a
// client-supplied x-tenant-id with the session's real tenantId. Exempting them would
// let an unauthenticated caller start an agent run under an arbitrary tenant.
export const config = {
    matcher: [
        "/((?!api/auth|api/health|api/v1/trigger|api/v1/gateway/telegram|api/v1/gateway/slack|api/v1/gateway/discord|api/v1/gateway/jira|api/v1/gateway/webhook|_next/static|_next/image|favicon.ico|placeholder.*|smc-global-securities-logo.jpg|login|signup).*)",
    ],
};

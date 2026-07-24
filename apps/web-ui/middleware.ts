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

export const config = {
    matcher: [
        "/((?!api/auth|api/health|api/v1/trigger|api/v1/gateway|_next/static|_next/image|favicon.ico|placeholder.*|smc-global-securities-logo.jpg|login|signup).*)",
    ],
};

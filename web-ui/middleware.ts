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
                // Public routes — no auth required
                if (
                    pathname === "/login" ||
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
        "/((?!api/auth|api/health|api/v1/trigger|_next/static|_next/image|favicon.ico|placeholder.*|smc-global-securities-logo.jpg|login).*)",
    ],
};

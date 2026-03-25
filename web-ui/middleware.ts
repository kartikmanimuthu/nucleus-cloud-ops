import { withAuth } from "next-auth/middleware"

export default withAuth(
    function middleware(req) {},
    {
        callbacks: {
            authorized: ({ token, req }) => {
                const { pathname } = req.nextUrl;
                if (
                    pathname === '/login' ||
                    pathname === '/' ||
                    pathname.startsWith('/docs')
                ) {
                    return true;
                }
                return !!token;
            },
        },
    }
)

export const config = {
    matcher: [
        '/((?!api/auth|api/health|api/v1/trigger|_next/static|_next/image|favicon.ico|placeholder.*|smc-global-securities-logo.jpg|login).*)'
    ]
}

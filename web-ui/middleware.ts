import { withAuth } from "next-auth/middleware"

export default withAuth(
    function middleware(req) {
        // Additional middleware logic can go here
    },
    {
        callbacks: {
            authorized: ({ token, req }) => {
                // Allow access to login page without authentication
                if (req.nextUrl.pathname === '/login') {
                    return true
                }

                // Require authentication for all other pages
                return !!token
            },
        },
    }
)

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - api/auth (authentication routes)
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * - public assets (placeholder images, logos)
         * - login page
         */
        '/((?!api/auth|api/health|api/v1/trigger|_next/static|_next/image|favicon.ico|placeholder.*|smc-global-securities-logo.jpg|login).*)'
    ]
}

# Phase 12: Auth Foundation - Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Dual auth (Cognito + Credentials), Prisma adapter for user persistence, session normalization with tenantId/role/isSuperAdmin on every session regardless of provider. Database session strategy for server-side invalidation. Middleware injects x-tenant-id header. Super admin guard on /admin routes.

</domain>

<decisions>
## Implementation Decisions

### Login UI design
- **D-01:** Tabbed login form on single `/login` page — two tabs: "Email & Password" (Credentials) and "SSO" (Cognito)
- **D-02:** Default tab is "Email & Password" (most users will be Credentials-based managed users)
- **D-03:** Inline field errors (red text below email/password fields) for login failures — wrong password, account locked, Cognito errors
- **D-04:** "Forgot password?" link on Credentials tab — uses NextAuth built-in password reset flow (sends reset email)

### Session migration strategy
- **D-05:** Hard cutover from JWT to database sessions — all existing JWT sessions invalidated on deploy, users must re-login
- **D-06:** Database session TTL is 24 hours
- **D-07:** Tenant suspension status cached for 5 minutes — reduces DB load, suspension enforcement delayed up to 5 min

### Super admin bootstrapping
- **D-08:** First-user-wins — the first user to register/login becomes super admin (`isSuperAdmin = true`)
- **D-09:** Super admin is platform-level only — NOT a member of any tenant. Accesses `/admin` routes only. No tenant data access through normal app routes.

### Password policy
- **D-10:** Minimum 8 characters, at least 1 uppercase, 1 lowercase, 1 number. No special character requirement.
- **D-11:** Account lockout after 5 failed login attempts — locked for 15 minutes. Show "too many attempts, try again in X minutes" error.
- **D-12:** bcrypt cost factor 12 for password hashing (~250ms hash time)

### Claude's Discretion
- Prisma adapter model naming (AuthUser, AuthAccount, AuthSession — @@map to auth_* tables per STATE.md decision)
- x-tenant-id header injection implementation details in middleware
- Cognito callback handling and token extraction
- Password reset email template content
- Loading skeleton design on login page
- Error state handling for Cognito provider failures

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Auth configuration
- `web-ui/lib/auth-options.ts` — Current NextAuth config with Cognito provider, JWT/session callbacks
- `web-ui/lib/auth-session.ts` — Current session access helpers (getServerSession, getSessionUserId)
- `web-ui/app/api/auth/[...nextauth]/route.ts` — NextAuth route handler

### RBAC (current CASL implementation — will be replaced in Phase 13)
- `web-ui/lib/rbac/authorize.ts` — Current authorize() function using CASL
- `web-ui/lib/rbac/abilities.ts` — Current role-to-permission mapping
- `web-ui/lib/rbac/types.ts` — Actions and Subjects type definitions
- `web-ui/lib/rbac/server-ability.ts` — Server-side ability builder

### Database schema
- `web-ui/prisma/schema.prisma` — Prisma schema with UserTenantRole model, tenant_id on all models
- `docs/schema-design.md` — DynamoDB single-table schema (reference for migration context)

### Middleware & auth components
- `web-ui/middleware.ts` — Current Next.js middleware (withAuth, route matching)
- `web-ui/app/login/page.tsx` — Current login page (Cognito-only, will be rewritten)
- `web-ui/components/auth-guard.tsx` — Client-side auth guard component

### Repository pattern
- `web-ui/lib/db/repository-factory.ts` — Feature flag pattern for backend switching (USE_PG_RBAC)
- `web-ui/lib/db/repositories/rbac/postgres.ts` — PostgreSQL RBAC repository (UserTenantRole queries)

### Project context
- `.planning/REQUIREMENTS.md` — AUTH-01 through AUTH-07 requirements for this phase
- `.planning/PROJECT.md` — Key decisions: database sessions for suspension, Prisma adapter naming, dual auth rationale

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `web-ui/app/login/page.tsx`: Existing login page with Cognito button — will be rewritten to tabbed form but layout/styling can be reused
- `web-ui/components/auth-guard.tsx`: Client-side auth guard — can be extended for super admin checks
- `web-ui/lib/rbac/authorize.ts`: authorize() pattern — Phase 12 adds assertSuperAdmin() and getSessionTenantId() alongside it
- `web-ui/components/ui/`: Radix UI primitives (Tabs, Input, Button, Label) — use for login form
- `web-ui/lib/db/repository-factory.ts`: Feature flag pattern — same approach for session backend switching

### Established Patterns
- NextAuth with custom callbacks (JWT + session) in `auth-options.ts` — extend with Credentials provider and database adapter
- `getServerSession(authOptions)` used in all API routes — session shape change must be backwards-compatible during transition
- `withAuth` middleware wrapper — extend to inject x-tenant-id header
- Two-tier role model: Cognito groups (system-level) + UserTenantRole (tenant-level) — session must normalize both

### Integration Points
- `web-ui/middleware.ts`: Add x-tenant-id header injection and super admin route guard
- `web-ui/lib/auth-options.ts`: Add CredentialsProvider, Prisma adapter, database session strategy
- `web-ui/lib/auth-session.ts`: Add getSessionTenantId() and assertSuperAdmin() helpers
- `web-ui/prisma/schema.prisma`: Add AuthUser, AuthAccount, AuthSession, VerificationToken models
- Every API route using `getServerSession()`: Session shape changes from `{ email, groups, sub }` to `{ id, email, tenantId, role, isSuperAdmin }`

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for implementation details not covered by decisions above.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 12-auth-foundation*
*Context gathered: 2026-03-31*

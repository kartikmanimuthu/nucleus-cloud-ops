# Phase 15: Self-Service Signup - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Self-service user signup and tenant creation. Users sign up via Credentials (email/password) or Cognito SSO, then create an organization post-login. User becomes Owner of the new tenant. No admin panel, no suspension enforcement, no admin audit logging in this phase — those are deferred.

**Scope change from ROADMAP.md:** Original Phase 15 was "Super Admin + Onboarding + Suspension". User decided self-service onboarding replaces admin-initiated onboarding. Admin panel (ADMIN-01–07), suspension enforcement (SUSP-01–04), and admin audit logging are deferred to a future phase.

</domain>

<decisions>
## Implementation Decisions

### Onboarding model
- **D-01:** Self-service — no admin-initiated tenant creation. Users sign up and create their own org. Super admin panel is deferred.
- **D-02:** Post-login org creation — signup creates user account only. After first login, user without a tenant is redirected to `/create-org` to create their organization.

### Signup flow
- **D-03:** Separate `/signup` page with both auth providers (Credentials email/password + Cognito SSO). Link from login page ("Don't have an account? Sign up").
- **D-04:** No email verification required — user signs up and can create org immediately.
- **D-05:** Users without a tenant are redirected to `/create-org` after login. Access to `/app/*` is blocked until org exists (middleware gate).

### Org creation
- **D-06:** `/create-org` page collects org name and slug only. Timezone and other settings deferred to Phase 17 (Tenant Settings).
- **D-07:** Slug validation: lowercase alphanumeric + hyphens, 3-50 chars, unique across all tenants. Validated on blur with real-time availability check via API.
- **D-08:** On org creation: Tenant record created (status=active), user assigned Owner role via UserTenantRole, session updated with tenantId, redirect to `/app`.

### Auth providers at signup
- **D-09:** Both Credentials and Cognito SSO available on signup page — consistent with dual-auth from Phase 12.
- **D-10:** Cognito SSO signup: user authenticates via Cognito, account created in AuthUser table, then redirected to `/create-org` same as Credentials flow.

### Claude's Discretion
- Signup page layout and styling (reuse login page patterns)
- `/create-org` form design and validation UX
- Error handling for duplicate emails across providers
- How to handle Cognito user who already exists in Cognito pool but not in local DB
- Middleware implementation for no-tenant redirect logic
- API endpoint design for slug availability check and org creation

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Auth foundation (Phase 12 output)
- `web-ui/lib/auth-options.ts` — NextAuth config with dual providers (Cognito + Credentials), session callbacks
- `web-ui/lib/auth-session.ts` — `getSessionTenantId()`, `assertSuperAdmin()`, `getAuthSession()`
- `web-ui/lib/auth-types.ts` — Session type augmentation with tenantId, role, isSuperAdmin
- `web-ui/middleware.ts` — Current middleware with admin guard and x-tenant-id injection (needs no-tenant redirect)
- `web-ui/app/login/page.tsx` — Existing login page with tabbed Credentials + SSO (reference for signup page)

### Database schema
- `prisma/schema.prisma` — Tenant model (id, name, status, createdAt), AuthUser, UserTenantRole models

### RBAC (Phase 13 output)
- `web-ui/lib/rbac/types.ts` — PredefinedRole type (Owner, Admin, Member, Viewer)
- `web-ui/lib/rbac/authorize.ts` — authorize() function, role hierarchy

### Tenant isolation (Phase 14 output)
- `web-ui/lib/db/pg-config.ts` — `getTenantClient()` factory for scoped Prisma client

### Requirements
- `.planning/REQUIREMENTS.md` — ONBD-01 (tenant creation), AUTH-01–04 (auth foundation already complete)

### Project context
- `.planning/PROJECT.md` — Key decisions: self-serve signup was previously Out of Scope, now reversed for Phase 15

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `web-ui/app/login/page.tsx`: Tabbed login form (Credentials + SSO) — signup page can mirror this layout
- `web-ui/components/ui/`: Input, Button, Label, Tabs, Card primitives from Radix/shadcn
- `web-ui/lib/auth-options.ts`: Dual provider config — signup uses same providers
- `web-ui/lib/auth-session.ts`: Session helpers — `getSessionTenantId()` returns tenantId or throws (used for redirect logic)
- `web-ui/middleware.ts`: Already handles auth routing — extend for no-tenant redirect

### Established Patterns
- NextAuth Credentials provider with bcrypt password hashing (Phase 12)
- Prisma adapter for user persistence (AuthUser, AuthAccount, AuthSession models)
- `withAuth` middleware wrapper for route protection
- Service layer static classes for DB operations
- API routes: `authorize()` → `getSessionTenantId()` → service call

### Integration Points
- `web-ui/middleware.ts`: Add no-tenant redirect logic (if authenticated + no tenantId → redirect to /create-org)
- `web-ui/app/signup/page.tsx`: New signup page (mirrors login page structure)
- `web-ui/app/create-org/page.tsx`: New org creation page
- `web-ui/app/api/tenants/route.ts`: New API for tenant creation + slug availability check
- `prisma/schema.prisma`: Add `slug` column to Tenant model (unique constraint)
- `web-ui/lib/auth-options.ts`: Ensure signup flow creates AuthUser correctly for both providers
- NextAuth session callback: Update tenantId after org creation

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for implementation details not covered by decisions above.

</specifics>

<deferred>
## Deferred Ideas

- **Super admin panel** (ADMIN-01–07) — monitoring dashboard, tenant list, tenant detail views. Deferred to future phase.
- **Suspension enforcement** (SUSP-01–04) — read-only/locked modes, middleware tenant status check, session invalidation. Deferred to future phase.
- **Admin audit logging** (ADMIN-07) — admin action audit trail. Deferred with admin panel.
- **Email verification on signup** — decided against for now, can add later if spam becomes an issue.
- **Timezone collection at org creation** — deferred to Phase 17 (Tenant Settings).
- **Auto-suggest slug from org name** — decided against, standard manual slug entry.

</deferred>

---

*Phase: 15-super-admin-onboarding-suspension*
*Context gathered: 2026-04-01*

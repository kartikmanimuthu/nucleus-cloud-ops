# Project Research Summary

**Project:** Nucleus Cloud Ops — v3.0 Multi-Tenancy
**Domain:** SaaS multi-tenancy on existing Next.js + Prisma + NextAuth
**Researched:** 2026-03-31
**Confidence:** HIGH

## Executive Summary

This milestone adds full multi-tenancy to an existing single-tenant Next.js 15 + Prisma + NextAuth v4 platform. The approach is row-level isolation (single PostgreSQL schema, `tenant_id` on every table) — the right call for this scale. The `tenant_id` column already exists from v1.0; the work is enforcing it consistently in every query, every Lambda, and every agent thread. The stack additions are minimal: `@next-auth/prisma-adapter` + `bcryptjs` for dual auth, `resend` for email, and a custom ~100-line RBAC system that replaces `@casl/ability` entirely. No new infrastructure, no new services.

The recommended build order is strictly dependency-driven: auth foundation first (Prisma adapter + dual provider + session normalization), then RBAC replacement, then tenant context enforcement across all API routes and Lambdas, then the user-facing features (org switcher, super admin panel, invitations, settings). This order is non-negotiable — every subsequent phase inherits the tenant isolation guarantee established in Phase 1. Skipping ahead creates security holes that are expensive to retrofit.

The dominant risk is tenant data leakage via a Prisma query that omits `WHERE tenant_id = $1`. This is silent — the app works correctly for the logged-in user but leaks other tenants' data. The mitigation is a scoped Prisma client factory (`getTenantClient(tenantId)`) that seals `tenantId` at construction time using Prisma Client Extensions, making it structurally impossible to query without it. The second major risk is the CASL-to-custom-RBAC migration: removing CASL before the new system is complete creates a window of zero authorization enforcement. A parallel-run strategy with per-route feature flags is required.

---

## Key Findings

### Recommended Stack

The existing stack (Next.js 15, Prisma 5, NextAuth v4, Tailwind, Radix UI) requires only four new runtime packages. The CASL library (`@casl/ability`, `@casl/react`) is removed. No new infrastructure is needed — tenant context flows through the existing PostgreSQL database and Next.js middleware.

**Core technologies:**
- `@next-auth/prisma-adapter ^1.0.7`: persist NextAuth users/sessions in PostgreSQL for Credentials provider — must use v4-compatible adapter, NOT `@auth/prisma-adapter` (Auth.js v5, incompatible)
- `bcryptjs ^3.0.3`: password hashing for Credentials provider — pure JS, no native bindings, works in Node 20 ECS Fargate without Docker build issues
- `resend ^6.10.0`: transactional email for invitations — API-first, no SMTP config, 3K free emails/month; eliminates SES/Nodemailer setup complexity
- `@react-email/components ^1.0.10`: React-based email templates — pairs with Resend, keeps templates in the same TypeScript codebase
- Custom RBAC (no library): static `ROLE_PERMISSIONS` map in `permissions.ts` — ~100 lines, zero dependencies, full Prisma query control; `casbin`/`permify`/`accesscontrol` all add abstraction that fights against Prisma's query model

**Environment variables to add:** `RESEND_API_KEY`, `RESEND_FROM_EMAIL`

### Expected Features

All features below are in scope for v3.0. The dependency chain is strict: row-level isolation must be verified before any other feature ships.

**Must have (table stakes):**
- Row-level tenant isolation enforced in every Prisma query — foundational safety, data leak = trust-ending bug
- Dual auth (Cognito + Credentials) with Prisma adapter — users exist in PostgreSQL, session shape normalized across both providers
- Custom RBAC per module (Owner/Admin/Member/Viewer + custom roles) — replaces CASL entirely
- Tenant onboarding via super admin — super admin creates org + root user invite; no self-serve signup
- User invitation system — email invite, role pre-assigned, 48h expiry, accept/decline
- Org switcher in header — switch between tenants without re-login; full data reload on switch
- Tenant suspension — read-only mode (mutations blocked) and locked mode (login blocked); middleware-enforced
- Super admin panel (`/admin`) — list/create/suspend tenants; platform-level only, not a tenant member
- Tenant settings — name, timezone, notification preferences, logo

**Should have (differentiators):**
- Per-module custom role creation per tenant — tenants model their own org structure (e.g., "FinOps Viewer")
- Invitation with pre-assigned role — role baked into invite; inviter cannot escalate beyond their own role
- Two suspension modes (read-only vs locked) — read-only useful for billing disputes
- Tenant-level branding — logo + display name in layout

**Defer (v4+):**
- SSO/SAML per tenant — Cognito covers enterprise SSO at platform level for now
- Billing/subscription tiers — suspension covers non-payment case; Stripe is a separate milestone
- Self-serve tenant signup — enterprise cloud ops platform; super-admin-initiated onboarding only
- Schema-per-tenant isolation — operational nightmare at this scale; row-level is correct

### Architecture Approach

The architecture extends the existing layered pattern: Next.js middleware injects `x-tenant-id` from the JWT into every request header, API routes extract it via `getSessionTenantId()` (never from request body), service layer passes it explicitly to Prisma, and Prisma enforces it via a scoped client factory. The org switch uses NextAuth's `update()` trigger (`trigger === 'update'` in the JWT callback) to refresh the session cookie with the new `tenantId` — no full page reload, just `router.refresh()`. Super admin is a platform-level flag (`User.isSuperAdmin`) never assignable through any tenant UI.

**Major components:**
1. `web-ui/middleware.ts` — tenant header injection + super-admin route guard (`/app/admin`, `/api/admin`)
2. `web-ui/lib/auth-options.ts` — add CredentialsProvider; extend JWT/session callbacks with `tenantId`, `role`, `isSuperAdmin`
3. `web-ui/lib/rbac/` — full replacement: remove CASL, add static `ROLE_PERMISSIONS` map + new `authorize()`
4. `web-ui/lib/tenant-service.ts` — tenant CRUD, suspension, onboarding (new)
5. `web-ui/lib/invitation-service.ts` — token generation, email dispatch, accept/decline flow (new)
6. `web-ui/components/org-switcher/` — header dropdown, calls `update()` from `next-auth/react` (new)
7. `prisma/schema.prisma` — add `User`, `TenantMembership`, `Invitation` models; add `status`/`slug`/`settings` to `Tenant`
8. `lambda/scheduler/` — verify all queries include `tenantId` filter; skip suspended tenants before executing

### Critical Pitfalls

1. **Tenant data leak via missing `tenant_id` in Prisma queries** — wrap every Prisma client in a `getTenantClient(tenantId)` factory using Prisma Client Extensions; never expose raw `prisma` to service layer; write a two-tenant isolation test before any feature work
2. **`tenantId` read from request body instead of session** — always extract from `getServerSession()` or the `x-tenant-id` header injected by middleware; grep for `req.body.tenantId` as a code review gate
3. **CASL removal window leaves routes unguarded** — build and test new RBAC completely before removing a single CASL import; use per-route feature flag; never delete `@casl/ability` from `package.json` until every route is migrated
4. **Dual auth session shape mismatch** — normalize both Cognito and Credentials outputs to `{ id, tenantId, role, isSuperAdmin, email }` in the JWT callback; use TypeScript module augmentation to catch shape mismatches at compile time
5. **Tenant suspension not enforced on active sessions** — use database sessions (`strategy: 'database'`), not JWT; on suspension, delete all active sessions for that tenant's users from the `Session` table directly
6. **Super admin accessible to tenant admin** — `isSuperAdmin` is a separate boolean flag, never a role string; `/admin` routes check `token.isSuperAdmin === true`, not `role === 'admin'`
7. **LangGraph thread IDs not namespaced by tenant** — namespace all thread IDs as `${tenantId}:${userId}:${uuid}`; validate embedded `tenantId` matches session before loading any checkpoint
8. **Lambda cross-tenant contamination** — every Lambda DB query must include `WHERE tenant_id = $1`; add `tenantId` to all SQS message attributes; skip schedules for suspended tenants

---

## Implications for Roadmap

Based on research, the dependency graph is strict and the build order is clear. Seven phases, each unblocking the next.

### Phase 1: Auth Foundation
**Rationale:** Everything else depends on `tenantId` being in the session and users existing in PostgreSQL. Dual auth, Prisma adapter, and session normalization must be rock-solid before any feature code reads from the session.
**Delivers:** CredentialsProvider working alongside Cognito; `session.user.tenantId`, `role`, `isSuperAdmin` populated for both providers; `getSessionTenantId()` / `assertSuperAdmin()` helpers; middleware with tenant header injection and super-admin route guard; Prisma models for `AuthUser`, `AuthAccount`, `AuthSession`, `VerificationToken`
**Addresses:** Dual auth (table stakes), session shape normalization, account linking strategy
**Avoids:** Dual auth session shape mismatch (Pitfall 5), Cognito + Credentials account collision (Pitfall 6)

### Phase 2: Custom RBAC (Replace CASL)
**Rationale:** Role is now in the session (Phase 1). CASL must be replaced before tenant-scoped features are built — new features should use the new RBAC from day one, not inherit CASL debt.
**Delivers:** Static `ROLE_PERMISSIONS` map; new `authorize()` with default-deny baseline; all existing API routes migrated; `@casl/ability` removed from `package.json`
**Uses:** Custom RBAC pattern from STACK.md; `permissions.ts` + `authorize.ts` from ARCHITECTURE.md
**Avoids:** CASL removal window (Pitfall 3), default-deny RBAC gap (Pitfall 4)

### Phase 3: Tenant Context Enforcement
**Rationale:** With auth and RBAC in place, enforce `tenantId` consistently across all existing API routes, service layer, and Lambdas. This is the "make it safe" phase — no new user-facing features, just hardening.
**Delivers:** Scoped Prisma client factory (`getTenantClient`); all `DEFAULT_TENANT_ID` fallbacks removed; suspension check in middleware; scheduler Lambda verified for tenant isolation; LangGraph thread IDs namespaced
**Addresses:** Row-level tenant isolation (foundational table stake)
**Avoids:** Tenant data leak (Pitfall 1), `tenantId` from request body (Pitfall 2), Lambda cross-tenant contamination (Pitfall 10), LangGraph session leak (Pitfall 11)

### Phase 4: Org Switcher
**Rationale:** Tenant context is now enforced (Phase 3). The switcher is low-complexity but requires the full isolation stack to be correct — switching tenants must re-scope all data cleanly.
**Delivers:** `OrgSwitcher` header component; `getUserTenants()` service method; NextAuth `update()` trigger wired to session refresh; React Query cache keys include `tenantId`
**Addresses:** Org/tenant switcher (table stake)
**Avoids:** Org switcher stale cache (Pitfall 12)

### Phase 5: Super Admin Panel
**Rationale:** Tenant CRUD must exist before invitations (you invite users to a tenant that already exists). Super admin panel is the operator's control plane.
**Delivers:** `TenantService` (create, list, suspend, unsuspend, settings); `/api/admin/tenants/**` routes; `/app/admin/tenants/**` pages; two suspension modes (read-only, locked); `Tenant`, `TenantMembership` Prisma models
**Addresses:** Super admin panel (table stake), tenant onboarding, tenant suspension
**Avoids:** Super admin accessible to tenant admin (Pitfall 9), suspension not enforced on active sessions (Pitfall 8)

### Phase 6: User Invitations
**Rationale:** Depends on Phase 1 (User model + Prisma adapter), Phase 2 (role assigned at invite time), and Phase 5 (tenant must exist before inviting). Email delivery via Resend.
**Delivers:** `InvitationService` (token generation, email, accept/decline); `/api/invitations/**` routes; `/app/invite/[token]` public page; invitation management in tenant settings
**Uses:** `resend`, `@react-email/components` from STACK.md; `Invitation` Prisma model from ARCHITECTURE.md
**Avoids:** Invitation tokens guessable or reusable (Pitfall 7)

### Phase 7: Tenant Settings
**Rationale:** Lowest risk, no blockers after Phase 5. Settings are a JSON field on the `Tenant` model — straightforward CRUD.
**Delivers:** Settings form (display name, timezone, notification preferences, logo upload); tenant-admin scoped; wired to `Tenant.settings` JSON field
**Addresses:** Tenant settings (table stake), tenant branding (differentiator)

### Phase Ordering Rationale

- Phases 1–3 are security infrastructure — they must complete before any user-facing feature ships. No exceptions.
- Phase 2 (RBAC) runs immediately after Phase 1 because the new RBAC reads `role` from the session established in Phase 1. Delaying RBAC means new features inherit CASL debt.
- Phase 3 (enforcement) is a codebase-wide audit pass. It's unglamorous but the most important phase for security correctness.
- Phases 4–7 are largely independent once Phase 3 is complete, but Phase 5 (super admin) must precede Phase 6 (invitations) because tenants must exist before users can be invited to them.
- Lambda tenant awareness and LangGraph thread namespacing are bundled into Phase 3 — same pattern (add `tenantId` filter) applied to different runtimes.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Tenant Context Enforcement):** Requires a full audit of all existing service files and Lambda handlers to identify every query missing `tenantId`. Run `grep -r "prisma\." web-ui/lib/ --include="*.ts"` as a pre-planning step — scope could be 5 files or 50.
- **Phase 6 (Invitations):** Resend domain verification and DNS setup (SPF/DKIM) must happen before this phase can be tested end-to-end. Not a code problem, but a blocker if not started early — initiate on Day 1.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Auth Foundation):** NextAuth Prisma adapter + CredentialsProvider are fully specified in STACK.md and ARCHITECTURE.md — no unknowns.
- **Phase 2 (Custom RBAC):** Static permission map pattern is fully specified in ARCHITECTURE.md.
- **Phase 4 (Org Switcher):** NextAuth `update()` trigger pattern is documented; React Query cache key pattern is standard.
- **Phase 5 (Super Admin):** Standard CRUD with a role guard. No novel patterns.
- **Phase 7 (Tenant Settings):** JSON field CRUD. Simplest phase in the roadmap.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All package versions verified from npm registry 2026-03-31; compatibility matrix confirmed |
| Features | HIGH | Well-established SaaS patterns; corroborated by Linear/Vercel/AWS Organizations reference |
| Architecture | HIGH | Based on direct codebase analysis of existing files + verified NextAuth/Prisma patterns |
| Pitfalls | HIGH | Core patterns (OWASP, NextAuth session behavior, Prisma extensions) are well-established; LangGraph checkpoint behavior is MEDIUM |

**Overall confidence:** HIGH

### Gaps to Address

- **LangGraph checkpoint migration:** Existing thread IDs in the checkpointer are bare UUIDs. A migration script is needed to rename them to `${tenantId}:${userId}:${uuid}` format before multi-tenant launch. Scope unknown — depends on how many active threads exist. Flag for Phase 3 planning.
- **Resend domain verification timing:** DNS propagation for SPF/DKIM can take 24–48h. Must be initiated at project start, not when Phase 6 begins. Add as a Day 1 task.
- **Prisma adapter model naming collision:** The existing schema has an `Account` model (AWS cloud accounts). The NextAuth adapter also needs an `Account` model. The resolution (use `AuthAccount` with `@@map("auth_accounts")`) is specified in STACK.md — must be applied carefully to avoid breaking existing AWS account queries.
- **Database session strategy performance:** Switching from JWT to database sessions (required for suspension enforcement) adds a DB lookup on every authenticated request. Acceptable at current scale; flag for Phase 1 planning if latency becomes a concern.

---

## Sources

### Primary (HIGH confidence)
- npm registry — `@next-auth/prisma-adapter`, `bcryptjs`, `resend`, `@react-email/components` versions verified 2026-03-31
- https://next-auth.js.org/providers/credentials — CredentialsProvider setup
- https://next-auth.js.org/configuration/callbacks#jwt-callback — JWT `trigger: 'update'` for org switching
- https://resend.com/docs/send-with-nodejs — Resend Node.js usage
- https://nextjs.org/docs/app/building-your-application/routing/middleware — Next.js middleware patterns
- https://www.prisma.io/docs/orm/prisma-schema/data-model/relations — Prisma schema relations
- Direct codebase analysis — existing `tenant_id` columns, CASL usage in `web-ui/lib/rbac/`, Lambda handlers

### Secondary (MEDIUM confidence)
- OWASP multi-tenancy security guidelines — horizontal privilege escalation, tenant isolation patterns
- LangGraph checkpointing documentation — thread ID and state management (verify against current LangGraph version in use)
- SaaS reference patterns (Linear, Vercel, AWS Organizations) — org switcher, invitation, suspension UX

### Tertiary (LOW confidence)
- LangGraph checkpoint migration path — no official docs on renaming existing thread IDs; verify against `@farukada/aws-langgraph-dynamodb-ts` implementation during Phase 3 planning

---
*Research completed: 2026-03-31*
*Ready for roadmap: yes*

# Roadmap: Nucleus Cloud Ops

## Milestones

- ✅ **v1.0** DynamoDB → PostgreSQL Migration — Shipped 2026-03-28 → [archive](milestones/v1.0-ROADMAP.md)
- ✅ **v2.0** Pulumi IaC Migration — Shipped 2026-03-30 → [archive](milestones/v2.0-ROADMAP.md)
- 🚧 **v3.0** Multi-Tenancy — Phases 12–17 (in progress)

## Phases

<details>
<summary>✅ v1.0 DynamoDB → PostgreSQL Migration (Phases 1–5) — SHIPPED 2026-03-28</summary>

See [archive](milestones/v1.0-ROADMAP.md) for full phase details.

</details>

<details>
<summary>✅ v2.0 Pulumi IaC Migration (Phases 6–11) — SHIPPED 2026-03-30</summary>

See [archive](milestones/v2.0-ROADMAP.md) for full phase details.

</details>

### 🚧 v3.0 Multi-Tenancy (In Progress)

**Milestone Goal:** Transform Nucleus Cloud Ops into a standard SaaS product with full multi-tenant isolation, custom per-module RBAC, tenant lifecycle management, and dual auth (Cognito + Credentials).

- [x] **Phase 12: Auth Foundation** - Dual auth (Cognito + Credentials), Prisma adapter, session normalization with tenantId/role/isSuperAdmin (completed 2026-03-31)
- [x] **Phase 13: Custom RBAC** - Replace CASL with static role/permission map; migrate all API routes; remove @casl/ability (completed 2026-03-31)
- [ ] **Phase 14: Tenant Context Enforcement** - Scoped Prisma client factory; remove DEFAULT_TENANT_ID fallbacks; Lambda + LangGraph tenant isolation
- [ ] **Phase 15: Super Admin + Onboarding + Suspension** - /admin panel, tenant CRUD, two-mode suspension with immediate session invalidation
- [ ] **Phase 16: User Invitations + Onboarding Completion** - Email invitations via Resend, accept/decline flow, multi-org membership
- [ ] **Phase 17: Org Switcher + Tenant Settings** - Header org dropdown, session-based tenant switch, settings form + logo upload

## Phase Details

### Phase 12: Auth Foundation
**Goal**: Users can authenticate via Cognito or email/password; every session carries tenantId, role, and isSuperAdmin regardless of provider
**Depends on**: Phase 11 (Pulumi infrastructure)
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06, AUTH-07
**Success Criteria** (what must be TRUE):
  1. User can log in with email + bcrypt password via Credentials provider
  2. User can log in via Cognito SSO; session shape is identical to Credentials login (`{ id, email, tenantId, role, isSuperAdmin }`)
  3. Session contains tenantId, role, and isSuperAdmin accessible in any API route via `getSessionTenantId()` / `assertSuperAdmin()`
  4. Every authenticated request has `x-tenant-id` header injected by middleware
  5. `/admin` and `/api/admin` routes return 403 for any user where `isSuperAdmin !== true`
**Plans**: 3 plans
Plans:
- [x] 12-01-PLAN.md — Prisma adapter models + dual auth config + database sessions
- [x] 12-02-PLAN.md — Session helpers (getSessionTenantId, assertSuperAdmin) + middleware x-tenant-id injection
- [x] 12-03-PLAN.md — Tabbed login page UI (Credentials + SSO)
**UI hint**: yes

### Phase 13: Custom RBAC
**Goal**: All API routes enforce custom role-based permissions; CASL is fully removed from the codebase
**Depends on**: Phase 12
**Requirements**: RBAC-01, RBAC-02, RBAC-03, RBAC-04, RBAC-05, RBAC-06, RBAC-07
**Success Criteria** (what must be TRUE):
  1. Owner/Admin/Member/Viewer roles each enforce distinct permission sets per module (Accounts, Schedules, AI Ops, Inventory, Settings)
  2. API route returns 403 when the user's role lacks the required action on the requested module
  3. Tenant admin can create a custom role with explicit per-module permissions scoped to their tenant
  4. No `@casl/ability` or `@casl/react` import exists anywhere in the codebase
  5. Role assignment via invitation or role change cannot exceed the inviter's/changer's own role level
**Plans**: 4 plans
Plans:
- [x] 13-01-PLAN.md — Permission system core (types, static map, authorize rewrite, hierarchy)
- [x] 13-02-PLAN.md — Migrate all API routes to new RBAC + remove CASL
- [x] 13-03-PLAN.md — Custom roles backend (Prisma model, service, API routes)
- [x] 13-04-PLAN.md — Custom roles UI (settings page, permission matrix, dialogs)
**UI hint**: yes

### Phase 14: Tenant Context Enforcement
**Goal**: Every database query is scoped to the requesting tenant; cross-tenant data access is structurally impossible
**Depends on**: Phase 13
**Requirements**: ISOL-01, ISOL-02, ISOL-03, ISOL-04, ISOL-05, ISOL-06
**Success Criteria** (what must be TRUE):
  1. A query made by Tenant A's user cannot return Tenant B's data in any module (verified by two-tenant isolation test)
  2. Service layer rejects requests with a missing tenantId as a hard error — no DEFAULT_TENANT_ID fallback exists
  3. Scheduler Lambda only processes schedules belonging to the correct tenant and skips suspended tenants
  4. LangGraph agent threads are namespaced as `tenantId:userId:uuid`; loading another tenant's thread returns 403
**Plans**: 4 plans
Plans:
- [x] 14-01-PLAN.md — Scoped Prisma client factory + DEFAULT_TENANT_ID removal from services/routes
- [x] 14-02-PLAN.md — LangGraph thread isolation (namespaced IDs, tenant validation, persistence bug fix)
- [ ] 14-03-PLAN.md — Lambda tenant isolation (scheduler iteration + discovery tagging)
- [ ] 14-04-PLAN.md — Two-tenant isolation integration test

### Phase 15: Super Admin + Onboarding + Suspension
**Goal**: Super admin can create, manage, and suspend tenants; suspension is enforced immediately across all active sessions
**Depends on**: Phase 14
**Requirements**: ADMIN-01, ADMIN-02, ADMIN-03, ADMIN-04, ADMIN-05, ADMIN-06, ADMIN-07, ONBD-01, SUSP-01, SUSP-02, SUSP-03, SUSP-04
**Success Criteria** (what must be TRUE):
  1. Super admin can create a new tenant (name, slug, timezone) and see it in the tenant list with status and user count
  2. Super admin can suspend a tenant in read-only mode; tenant users see a suspension banner and all write/delete API calls return 423
  3. Super admin can suspend a tenant in locked mode; tenant users cannot log in and all API calls return 423
  4. On suspension, all active database sessions for the tenant's users are deleted immediately (no grace period)
  5. All admin actions (create, suspend, unsuspend) appear in the audit log with actor, action, timestamp, and target tenant
**Plans**: TBD
**UI hint**: yes

### Phase 16: User Invitations + Onboarding Completion
**Goal**: Tenant admins can invite users via email; invited users can join the tenant and set up their accounts
**Depends on**: Phase 15
**Requirements**: INVT-01, INVT-02, INVT-03, INVT-04, INVT-05, INVT-06, ONBD-02, ONBD-03
**Success Criteria** (what must be TRUE):
  1. Tenant admin can send an invitation email with a pre-assigned role; email arrives via Resend with a valid accept link
  2. New user accepting an invitation can set a password and land in the correct tenant with the correct role
  3. Existing user accepting an invitation is added to the new tenant without losing access to their existing tenants
  4. Invitation link expires after 48 hours; expired or revoked links show an appropriate error
  5. Tenant admin can view pending invitations and revoke or resend them from the members page
**Plans**: TBD
**UI hint**: yes

### Phase 17: Org Switcher + Tenant Settings
**Goal**: Users can switch between orgs without re-login; tenant admins can configure org display settings and branding
**Depends on**: Phase 16
**Requirements**: ORGW-01, ORGW-02, ORGW-03, ORGW-04, STNG-01, STNG-02, STNG-03
**Success Criteria** (what must be TRUE):
  1. User belonging to multiple orgs sees a header dropdown listing all their orgs; selecting one updates the session and reloads all data scoped to the new tenant
  2. User belonging to only one org does not see the org switcher
  3. Tenant admin can update org display name, default timezone, and notification preferences
  4. Tenant admin can upload an org logo that appears in the header/sidebar
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 12 → 13 → 14 → 15 → 16 → 17

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 12. Auth Foundation | v3.0 | 3/3 | Complete    | 2026-03-31 |
| 13. Custom RBAC | v3.0 | 4/4 | Complete    | 2026-03-31 |
| 14. Tenant Context Enforcement | v3.0 | 2/4 | In Progress|  |
| 15. Super Admin + Onboarding + Suspension | v3.0 | 0/? | Not started | - |
| 16. User Invitations + Onboarding Completion | v3.0 | 0/? | Not started | - |
| 17. Org Switcher + Tenant Settings | v3.0 | 0/? | Not started | - |

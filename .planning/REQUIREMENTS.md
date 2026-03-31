# Requirements: Nucleus Cloud Ops v3.0 — Multi-Tenancy

**Defined:** 2026-03-31
**Core Value:** Transform Nucleus Cloud Ops into a standard SaaS product with full multi-tenant isolation, custom per-module RBAC, tenant lifecycle management, and dual auth (Cognito + Credentials).

## v3.0 Requirements

### Authentication

- [x] **AUTH-01**: NextAuth Prisma adapter persists users, accounts, and sessions in PostgreSQL (AuthUser, AuthAccount, AuthSession, VerificationToken models)
- [x] **AUTH-02**: CredentialsProvider allows login with email + bcrypt-hashed password alongside existing Cognito provider
- [x] **AUTH-03**: JWT/session callbacks normalize session shape to `{ id, email, tenantId, role, isSuperAdmin }` for both Cognito and Credentials providers
- [x] **AUTH-04**: Database session strategy (not JWT) enables server-side session invalidation for tenant suspension
- [ ] **AUTH-05**: `getSessionTenantId()` helper extracts tenantId from session; returns 401 if missing
- [ ] **AUTH-06**: `assertSuperAdmin()` helper checks `isSuperAdmin === true`; returns 403 if not
- [ ] **AUTH-07**: Next.js middleware injects `x-tenant-id` header from session into every authenticated request

### Custom RBAC

- [ ] **RBAC-01**: Static `ROLE_PERMISSIONS` map defines permissions for predefined roles (Owner, Admin, Member, Viewer) across all modules
- [ ] **RBAC-02**: Permission model supports granular actions (create, read, update, delete) per module (Accounts, Schedules, AI Ops, Inventory, Settings)
- [ ] **RBAC-03**: New `authorize(action, module)` function with default-deny baseline replaces CASL `authorize()` in all API routes
- [ ] **RBAC-04**: All existing API routes migrated from CASL to new RBAC system with parallel-run feature flag during transition
- [ ] **RBAC-05**: `@casl/ability` and `@casl/react` packages removed from package.json after full migration
- [ ] **RBAC-06**: Tenant admins can create custom roles with explicit per-module permission sets scoped to their tenant
- [ ] **RBAC-07**: Role assignment limited by inviter's own role level — no privilege escalation via invitation or role change

### Tenant Isolation

- [ ] **ISOL-01**: Scoped Prisma client factory (`getTenantClient(tenantId)`) using Prisma Client Extensions enforces `tenant_id` on every query
- [ ] **ISOL-02**: All `DEFAULT_TENANT_ID` fallbacks removed from service layer; missing tenant_id is a hard error
- [ ] **ISOL-03**: Scheduler Lambda includes `tenant_id` filter in all queries and skips schedules for suspended tenants
- [ ] **ISOL-04**: Discovery Lambda includes `tenant_id` in all inventory writes and SQS message attributes
- [ ] **ISOL-05**: LangGraph thread IDs namespaced as `tenantId:userId:uuid`; thread load validates embedded tenantId matches session
- [ ] **ISOL-06**: Two-tenant isolation test verifies that Tenant A cannot read/write Tenant B's data across all modules

### Super Admin Panel

- [ ] **ADMIN-01**: `/admin` route group accessible only to users with `isSuperAdmin === true`; middleware blocks all non-super-admin access
- [ ] **ADMIN-02**: Super admin can list all tenants with status, user count, and creation date
- [ ] **ADMIN-03**: Super admin can create a new tenant (org name, slug, root user email, default timezone)
- [ ] **ADMIN-04**: Super admin can view tenant details including member list and settings
- [ ] **ADMIN-05**: Super admin can suspend a tenant in read-only mode (mutations blocked, reads allowed) or locked mode (login blocked)
- [ ] **ADMIN-06**: Super admin can unsuspend a tenant, restoring full access
- [ ] **ADMIN-07**: All admin actions are audit-logged (who did what, when, to which tenant)

### Tenant Onboarding

- [ ] **ONBD-01**: Tenant creation generates a Tenant record (status=active) with slug, display name, and default settings
- [ ] **ONBD-02**: Root user receives an invitation email with a signed token (48h expiry) to set up their account
- [ ] **ONBD-03**: Root user can accept invite via Credentials (set password) or Cognito (SSO) — assigned Owner role automatically

### User Invitations

- [ ] **INVT-01**: Tenant admin can invite users by email with a pre-assigned role from the tenant settings/members page
- [ ] **INVT-02**: Invitation generates a cryptographically secure token with 48h expiry stored in Invitation table
- [ ] **INVT-03**: Invitation email sent via Resend with accept link pointing to `/auth/accept-invite?token=<token>`
- [ ] **INVT-04**: New user accepting an invite sets password (Credentials) or signs in via Cognito; account created and joined to tenant with pre-assigned role
- [ ] **INVT-05**: Existing user accepting an invite is added to the tenant with pre-assigned role (multi-org membership)
- [ ] **INVT-06**: Tenant admin can view pending invitations, resend (resets expiry), or revoke from settings

### Org Switcher

- [ ] **ORGW-01**: Header dropdown displays current org name and list of other orgs the user belongs to
- [ ] **ORGW-02**: Selecting a different org updates session tenantId via NextAuth `update()` trigger without full page reload
- [ ] **ORGW-03**: All data reloads scoped to the newly selected tenant after org switch
- [ ] **ORGW-04**: If user belongs to only one org, the switcher is hidden

### Tenant Suspension

- [ ] **SUSP-01**: Middleware checks tenant status on every authenticated request before any business logic executes
- [ ] **SUSP-02**: Read-only suspended tenants: all write/delete API calls return 423 Locked; reads allowed; users see suspension banner
- [ ] **SUSP-03**: Locked suspended tenants: all API calls return 423; login blocked at middleware; users see locked message
- [ ] **SUSP-04**: On suspension, all active database sessions for the tenant's users are deleted (immediate enforcement)

### Tenant Settings

- [ ] **STNG-01**: Tenant admin can update org display name, default timezone, and notification preferences from settings page
- [ ] **STNG-02**: Tenant admin can upload org logo displayed in the header/sidebar
- [ ] **STNG-03**: Settings stored as JSON field on Tenant model; scoped to tenant-admin role

## v3.x Requirements (Future)

### Invitation Management

- **INVT-07**: Invitation expiry management dashboard with bulk resend/revoke
- **INVT-08**: Invitation analytics (sent, accepted, expired, revoked counts)

### Audit & Monitoring

- **AUDT-01**: Role change audit log (who changed whose role, when, in which tenant)
- **AUDT-02**: Tenant usage dashboard in /admin (user count, last active, resource counts per tenant)

### Branding

- **BRND-01**: Custom color theme per tenant (beyond logo)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Schema-per-tenant isolation | Operational nightmare at this scale; row-level with tenant_id is correct |
| SSO/SAML per tenant | Cognito covers enterprise SSO at platform level; defer to v4.0 |
| Billing/subscription tiers | Significant complexity (Stripe); suspension covers non-payment case; defer to v4.0 |
| Usage quotas/rate limits | Defer to v4.0 |
| Self-serve tenant signup | Enterprise cloud ops; super-admin-initiated onboarding only |
| Permission inheritance chains | Explicit permission sets are more auditable than implicit inheritance |
| Impersonation (login as tenant) | Security/audit risk; super admin views tenant data directly in /admin |
| Real-time permission sync (WebSocket) | Over-engineered; re-validate on each API request is sufficient |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 12 | Complete |
| AUTH-02 | Phase 12 | Complete |
| AUTH-03 | Phase 12 | Complete |
| AUTH-04 | Phase 12 | Complete |
| AUTH-05 | Phase 12 | Pending |
| AUTH-06 | Phase 12 | Pending |
| AUTH-07 | Phase 12 | Pending |
| RBAC-01 | Phase 13 | Pending |
| RBAC-02 | Phase 13 | Pending |
| RBAC-03 | Phase 13 | Pending |
| RBAC-04 | Phase 13 | Pending |
| RBAC-05 | Phase 13 | Pending |
| RBAC-06 | Phase 13 | Pending |
| RBAC-07 | Phase 13 | Pending |
| ISOL-01 | Phase 14 | Pending |
| ISOL-02 | Phase 14 | Pending |
| ISOL-03 | Phase 14 | Pending |
| ISOL-04 | Phase 14 | Pending |
| ISOL-05 | Phase 14 | Pending |
| ISOL-06 | Phase 14 | Pending |
| ADMIN-01 | Phase 15 | Pending |
| ADMIN-02 | Phase 15 | Pending |
| ADMIN-03 | Phase 15 | Pending |
| ADMIN-04 | Phase 15 | Pending |
| ADMIN-05 | Phase 15 | Pending |
| ADMIN-06 | Phase 15 | Pending |
| ADMIN-07 | Phase 15 | Pending |
| ONBD-01 | Phase 15 | Pending |
| ONBD-02 | Phase 16 | Pending |
| ONBD-03 | Phase 16 | Pending |
| INVT-01 | Phase 16 | Pending |
| INVT-02 | Phase 16 | Pending |
| INVT-03 | Phase 16 | Pending |
| INVT-04 | Phase 16 | Pending |
| INVT-05 | Phase 16 | Pending |
| INVT-06 | Phase 16 | Pending |
| ORGW-01 | Phase 17 | Pending |
| ORGW-02 | Phase 17 | Pending |
| ORGW-03 | Phase 17 | Pending |
| ORGW-04 | Phase 17 | Pending |
| SUSP-01 | Phase 15 | Pending |
| SUSP-02 | Phase 15 | Pending |
| SUSP-03 | Phase 15 | Pending |
| SUSP-04 | Phase 15 | Pending |
| STNG-01 | Phase 17 | Pending |
| STNG-02 | Phase 17 | Pending |
| STNG-03 | Phase 17 | Pending |

**Coverage:**
- v3.0 requirements: 43 total
- Mapped to phases: 43
- Unmapped: 0

---
*Requirements defined: 2026-03-31*
*Last updated: 2026-03-31 — traceability mapped after roadmap creation*

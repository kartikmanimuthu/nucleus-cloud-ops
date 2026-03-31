# Feature Landscape: Multi-Tenancy SaaS

**Domain:** SaaS multi-tenancy — tenant lifecycle, custom RBAC, user invitations, org switching, tenant settings
**Researched:** 2026-03-31
**Confidence:** HIGH (well-established SaaS patterns; training data corroborated by platform analysis)

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features every SaaS platform must have. Missing any = product feels broken or unsafe.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Row-level tenant isolation | Users assume their data is private; data leakage is a trust-ending bug | MEDIUM | `tenant_id` already on most tables from v1.0; need to audit every query and enforce in repository layer |
| Tenant onboarding (super admin flow) | Platform operators need a way to provision new customers | MEDIUM | Super admin creates org + root user; root user gets invite email; no self-serve signup needed for enterprise cloud ops |
| User invitation via email | Standard SaaS pattern; users expect to invite teammates | MEDIUM | Token-based invite link (24–48h expiry), accept/decline, resend, revoke; new users set password on accept |
| Role-based access control | Users expect admins to have more power than members | HIGH | Replacing CASL entirely; custom roles per tenant; per-module permission matrix (module × action) |
| Org/tenant switcher | Users belonging to multiple orgs expect to switch without re-logging in | LOW | Header dropdown; full data reload on switch; current org persisted in session |
| Tenant suspension | Platform operators need to freeze bad actors or unpaid accounts | LOW | Suspended state blocks all mutations (or all logins); super admin can suspend/unsuspend with reason; audit logged |
| Super admin panel (/admin) | Platform operators need visibility and control over all tenants | MEDIUM | List tenants, create tenant, view users, suspend/unsuspend; behind super-admin auth guard; not a tenant member |
| Tenant settings page | Orgs expect to configure their own name, timezone, notifications | LOW | Display name, default timezone, notification preferences; scoped to tenant admin role |
| Dual auth (Cognito + Credentials) | Enterprise customers use SSO; smaller teams want simple email/password | MEDIUM | NextAuth multi-provider; Prisma adapter for user persistence; Cognito for enterprise, Credentials for direct-managed users |

### Differentiators (Competitive Advantage)

Features that go beyond baseline and add real value for a cloud ops platform.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Per-module RBAC (not just global roles) | Cloud ops teams have specialists — a scheduler admin shouldn't touch AI Ops config | HIGH | Permission matrix: role × module (Accounts, Schedules, AI Ops, Inventory, Settings) × action (create/read/update/delete); custom role creation per tenant |
| Custom role creation per tenant | Tenants model their own org structure (e.g., "FinOps Viewer", "DevOps Lead") | MEDIUM | Tenant admin defines role name + permission set; roles are tenant-scoped, not platform-global |
| Tenant-level branding | White-label feel; enterprise customers want their logo in the header | LOW | Logo upload, org display name; stored in tenant settings; rendered in layout |
| Invitation with pre-assigned role | Inviter specifies role at invite time, not after acceptance | LOW | Role baked into invitation record; assignable roles limited to inviter's own role level (no privilege escalation) |
| Suspension with read-only mode | Suspended tenants can still read data (useful for billing disputes) vs full lockout | LOW | Two suspension modes: `read_only` (mutations blocked) and `locked` (login blocked); super admin chooses |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Schema-per-tenant isolation | "True" isolation, easier per-tenant backup | Operational nightmare: migrations run N times, connection pool exhaustion, no cross-tenant queries | Row-level isolation with `tenant_id` enforced in repository layer — already the chosen pattern |
| Real-time permission sync (WebSocket) | Permissions change mid-session should take effect immediately | Over-engineered for this use case; adds WebSocket infrastructure; permissions rarely change mid-session | Re-validate permissions on each API request (already happens with server-side auth); session invalidation on role change is sufficient |
| Self-serve tenant signup | Reduce friction for new customers | Enterprise cloud ops platforms don't want random signups; creates compliance and security risk | Super-admin-initiated onboarding only; keeps tenant list clean and auditable |
| Billing/subscription tiers | Monetize different feature sets | Explicitly deferred to v4.0; adds significant complexity (Stripe integration, entitlement checks, dunning) | Suspension covers the "non-paying" case for now |
| SSO/SAML per tenant | Enterprise customers want their IdP | Deferred to v4.0; Cognito handles enterprise SSO at platform level for now | Dual auth (Cognito + Credentials) covers the enterprise vs SMB split |
| Permission inheritance chains (role hierarchy) | "Admin inherits all Member permissions" | Implicit inheritance creates confusion about what a role actually has; hard to audit | Explicit permission sets per role; predefined roles (Owner, Admin, Member, Viewer) have explicit permission sets, not inheritance |
| Impersonation ("login as tenant") | Super admin debugging | Security and audit risk; hard to implement safely | Super admin can view tenant data directly in /admin panel; no impersonation needed |

---

## Feature Dependencies

```
[Row-Level Tenant Isolation]
    └──required by──> [All other features]
                          (nothing works correctly without tenant_id enforcement)

[Dual Auth + Prisma Adapter]
    └──required by──> [User Invitations]
                          └──required by──> [Tenant Onboarding]
    └──required by──> [Custom RBAC]
                          └──required by──> [Per-Module Permissions]

[Tenant Entity (DB model)]
    └──required by──> [Org Switcher]
    └──required by──> [Tenant Settings]
    └──required by──> [Tenant Suspension]
    └──required by──> [Super Admin Panel]

[Super Admin Panel]
    └──enables──> [Tenant Onboarding]
    └──enables──> [Tenant Suspension]

[User Invitations]
    └──requires──> [Custom RBAC] (role assigned at invite time)
    └──requires──> [Email delivery] (Nodemailer or SES)

[Org Switcher]
    └──requires──> [Row-Level Tenant Isolation] (switching must re-scope all data)
    └──requires──> [Tenant entity in session]

[Tenant Suspension]
    └──requires──> [Middleware check on every request]
    └──enhances──> [Super Admin Panel] (suspension triggered from there)
```

### Dependency Notes

- **Row-level isolation is the foundation:** Every other feature assumes `tenant_id` is correctly enforced. Build and verify this first.
- **Dual auth before invitations:** Invitations create users in the Prisma-managed users table. The Prisma adapter must be wired into NextAuth before invitation acceptance can create accounts.
- **Custom RBAC before per-module permissions:** The role/permission DB schema must exist before you can assign roles at invite time or enforce module-level access.
- **Tenant entity before org switcher:** The switcher reads the list of tenants a user belongs to — requires the tenant membership model.
- **Suspension middleware must be early in request pipeline:** Check suspension state before RBAC, before any data access. A suspended tenant should never reach business logic.

---

## MVP Definition

### Launch With (v3.0 — all in scope per PROJECT.md)

- [ ] Row-level tenant isolation enforced across all repositories — foundational safety
- [ ] Dual auth (Cognito + Credentials) with Prisma adapter — users exist in PostgreSQL
- [ ] Tenant entity + super admin panel (create, list, view, suspend/unsuspend)
- [ ] Tenant onboarding flow (super admin creates org + root user invite)
- [ ] User invitation system (invite by email, role pre-assigned, accept/decline)
- [ ] Custom RBAC per module (replace CASL; Owner/Admin/Member/Viewer + custom roles)
- [ ] Org switcher in header (switch between tenants user belongs to)
- [ ] Tenant suspension (read-only and locked modes; middleware enforcement)
- [ ] Tenant-level settings (name, timezone, notification preferences, logo)

### Add After Validation (v3.x)

- [ ] Invitation expiry management UI (view pending, resend, revoke from settings)
- [ ] Role audit log (who changed whose role, when)
- [ ] Tenant usage dashboard in /admin (user count, last active, resource counts)

### Future Consideration (v4+)

- [ ] SSO/SAML per tenant — deferred; Cognito covers enterprise for now
- [ ] Billing/subscription tiers — deferred; suspension covers non-payment case
- [ ] Usage quotas/rate limits per tenant — deferred
- [ ] Self-serve tenant signup — deferred; enterprise onboarding only for now

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Row-level tenant isolation | HIGH | MEDIUM | P1 |
| Dual auth + Prisma adapter | HIGH | MEDIUM | P1 |
| Custom RBAC (replace CASL) | HIGH | HIGH | P1 |
| Tenant onboarding (super admin) | HIGH | MEDIUM | P1 |
| User invitations | HIGH | MEDIUM | P1 |
| Org switcher | MEDIUM | LOW | P1 |
| Tenant suspension | MEDIUM | LOW | P1 |
| Tenant settings | MEDIUM | LOW | P1 |
| Per-module custom roles | HIGH | MEDIUM | P1 |
| Tenant branding (logo) | LOW | LOW | P2 |
| Invitation management UI | LOW | LOW | P2 |
| Role audit log | MEDIUM | LOW | P2 |

**Priority key:** P1 = v3.0 launch, P2 = v3.x follow-on, P3 = v4+

---

## Standard SaaS Flow Reference

### Tenant Onboarding Flow (super-admin-initiated)

```
Super Admin
  → /admin/tenants/new
  → Enter: org name, root user email, default timezone
  → System creates: Tenant record (status=active) + pending User record
  → System sends: invite email to root user with signed token (48h expiry)

Root User
  → Clicks invite link → /auth/accept-invite?token=<jwt>
  → Token validated (not expired, not used, matches email)
  → Set password form (Credentials provider) OR "Sign in with Cognito" option
  → On complete: User activated, assigned Owner role for tenant
  → Redirected to tenant dashboard
```

### User Invitation Flow (tenant admin)

```
Tenant Admin
  → /settings/members → "Invite User"
  → Enter: email address, select role (limited to roles ≤ inviter's role)
  → System creates: Invitation record (status=pending, token, expiry=48h)
  → System sends: invite email with accept link

Invitee
  → Clicks link → /auth/accept-invite?token=<jwt>
  → If new user: set password → account created → joins tenant with pre-assigned role
  → If existing user (already in another tenant): confirm join → added to tenant
  → Invitation marked accepted

Tenant Admin (management)
  → Can see pending invitations in /settings/members
  → Can resend (resets expiry) or revoke (marks cancelled)
```

### RBAC Permission Model

```
Predefined roles (per tenant, not platform-global):
  Owner   → all permissions on all modules
  Admin   → all permissions except tenant deletion and owner management
  Member  → read + create on assigned modules; no delete
  Viewer  → read-only on all modules

Custom roles:
  Tenant admin defines role name + explicit permission set
  Permission set = { module: string, actions: ('create'|'read'|'update'|'delete')[] }[]
  Modules: Accounts, Schedules, AI_Ops, Inventory, Settings

Enforcement:
  API route → check session tenant_id → load user's role for that tenant
           → check role has required permission for module+action
           → 403 if not; proceed if yes
```

### Org Switcher Pattern

```
Header dropdown shows:
  - Current org name (with avatar/initials)
  - List of other orgs user belongs to
  - Clicking an org: updates session.tenantId → full page reload
  - All API calls include tenantId from session → data re-scoped automatically

Session shape:
  session.user.id
  session.user.tenantId        ← active tenant
  session.user.tenantIds[]     ← all tenants user belongs to
  session.user.role            ← role in active tenant
```

### Tenant Suspension States

```
active      → normal operation
read_only   → all write/delete API calls return 423 Locked; reads allowed
              users see banner: "This account is suspended. Contact support."
locked      → all API calls return 423; login blocked at middleware
              users see: "Account suspended. Contact support to restore access."
deleted     → soft delete; data retained; login blocked; not shown in /admin list by default

Transitions (super admin only):
  active → read_only  (suspend with read access)
  active → locked     (full suspension)
  read_only → active  (unsuspend)
  locked → active     (unsuspend)
  any → deleted       (irreversible via UI; requires explicit confirmation)
```

---

## Competitor Feature Analysis

| Feature | Linear / Vercel (SaaS reference) | AWS Organizations (domain reference) | Our Approach |
|---------|----------------------------------|--------------------------------------|--------------|
| Org switcher | Header dropdown, instant switch, workspace-scoped data | Account switcher in console header | Header dropdown, session-based tenantId, full reload |
| Invitations | Email invite with role, 7-day expiry, resend/revoke | Email invite to join org, role assigned | Email invite, 48h expiry, role pre-assigned, resend/revoke |
| RBAC | Global roles (Owner/Member) + fine-grained resource permissions | IAM policies (very granular, complex) | Per-module roles; predefined + custom; explicit permission sets |
| Suspension | Account deactivation (billing-driven) | Account suspension via Organizations | Two modes: read_only and locked; super admin triggered |
| Tenant settings | Workspace settings page (name, avatar, integrations) | Account settings (billing, contacts) | Name, timezone, notifications, logo; tenant-admin scoped |

---

## Sources

- SaaS multi-tenancy patterns: training data (HIGH confidence — well-established domain)
- NextAuth multi-provider + Prisma adapter: official NextAuth.js docs (https://next-auth.js.org/adapters/prisma)
- Row-level security patterns: PostgreSQL RLS documentation + Prisma middleware patterns
- RBAC permission model: CASL docs (being replaced), OWASP RBAC guidance
- Invitation token patterns: JWT signed tokens with expiry — standard practice
- Suspension state machine: derived from Stripe, Vercel, Linear SaaS patterns

---
*Feature research for: Multi-Tenancy SaaS (Nucleus Cloud Ops v3.0)*
*Researched: 2026-03-31*

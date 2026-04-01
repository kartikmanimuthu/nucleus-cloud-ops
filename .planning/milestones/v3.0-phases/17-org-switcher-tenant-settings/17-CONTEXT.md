# Phase 17: Org Switcher + Tenant Settings - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Users belonging to multiple orgs can switch between them via a sidebar dropdown without re-login. Single-org users see their org name but no switcher. Tenant admins can configure org display name, default timezone, notification preferences, and upload an org logo. Settings stored in TenantConfig table, scoped to Owner/Admin roles.

</domain>

<decisions>
## Implementation Decisions

### Org switcher placement & behavior
- **D-01:** Org switcher lives in the sidebar header, above the navigation items. Standard SaaS pattern (Linear, Slack, Notion).
- **D-02:** Multi-org users see a dropdown listing all their orgs (queried from UserTenantRole). Clicking a different org triggers an API call to validate access, then `session.update()` + `router.refresh()` to reload all data scoped to the new tenant.
- **D-03:** Single-org users see the org name displayed (no dropdown arrow, no switcher interaction). Per ORGW-04.
- **D-04:** Org switcher shows org logo (if uploaded) + org name. Current org is visually distinguished (checkmark or highlight).

### Tenant switch mechanism
- **D-05:** New API route `POST /api/tenants/switch` — accepts `tenantId`, verifies the user has a UserTenantRole for that tenant, returns success. The JWT/session callback in auth-options.ts must support switching the active tenantId.
- **D-06:** After switch: `update()` refreshes the session (re-runs session callback which reads the new active tenantId), then `router.refresh()` triggers server component re-render. No full page reload. Middleware's `x-tenant-id` header injection picks up the new tenantId automatically.
- **D-07:** The "active tenant" concept needs a way to persist which tenant the user is currently viewing. Options: (a) store `activeTenantId` on AuthUser model, or (b) use the first UserTenantRole as default and store switch state in session/JWT. Claude's discretion on implementation — the key requirement is that `getSessionTenantId()` returns the switched-to tenant after `update()`.

### Settings form
- **D-08:** New "Organization" tab in /app/settings alongside existing Roles and Members tabs. Contains: org display name (editable), slug (read-only display), default timezone (dropdown), notification preferences (toggles).
- **D-09:** Only Owner and Admin roles can edit tenant settings. Viewer and Member see read-only view. Enforced via `authorize('update', 'Settings')`.
- **D-10:** Settings stored in TenantConfig table (existing model) with configKey = 'org_settings'. JSON data field holds `{ timezone, notifications: { ... } }`.
- **D-11:** Org display name update also updates `Tenant.name` directly (not in TenantConfig). Timezone and notification prefs go in TenantConfig.

### Logo upload & display
- **D-12:** Logo upload via S3 presigned URL. New API route generates presigned PUT URL → client uploads directly to S3 → stores the S3 key in TenantConfig (configKey = 'org_logo'). Served via CloudFront.
- **D-13:** Logo appears in the sidebar header next to the org name (in the switcher area). Also appears in the org switcher dropdown for each org.
- **D-14:** Accepted formats: PNG, JPG, SVG. Max size: 2MB. Displayed as 32x32 in sidebar, 24x24 in dropdown. Fallback: first letter of org name in a colored circle.
- **D-15:** Logo upload UI: click-to-upload area in the Organization settings tab. Shows current logo with a "Change" button overlay.

### Data reload after switch
- **D-16:** `router.refresh()` triggers server component re-render with new tenantId from session. All server components re-fetch data scoped to the new tenant via `getSessionTenantId()` → `getTenantClient()`.
- **D-17:** Client components using `useSession()` get the updated session automatically after `update()`. Any client-side SWR/fetch hooks should re-validate (key includes tenantId or use a global revalidation trigger).

### Claude's Discretion
- Exact sidebar switcher component design and animation
- How to persist "active tenant" (AuthUser column vs session-only approach)
- Timezone dropdown implementation (list of IANA timezones or simplified list)
- Notification preferences structure (which notifications, toggle vs granular)
- S3 bucket selection for logo uploads (reuse existing bucket or dedicated)
- Logo image processing (resize on upload vs CSS-only scaling)
- Whether to show org slug in the switcher dropdown
- Error handling for failed org switch (e.g., user removed from org between page load and switch)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Auth & session (Phase 12 output)
- `web-ui/lib/auth-options.ts` — NextAuth config, JWT callback (tenantId population), session callback (must support tenant switching)
- `web-ui/lib/auth-session.ts` — `getSessionTenantId()`, `getAuthSession()` helpers
- `web-ui/lib/auth-types.ts` — Session type augmentation with tenantId, role, isSuperAdmin
- `web-ui/middleware.ts` — x-tenant-id header injection from session

### Sidebar & layout
- `web-ui/components/sidebar.tsx` — Current sidebar with user dropdown, nav items (org switcher goes here)

### Database schema
- `web-ui/prisma/schema.prisma` — Tenant model (name, slug, status), TenantConfig model (configKey, data JSON), UserTenantRole model (userId, tenantId, role)

### Settings page (Phase 16 output)
- `web-ui/app/app/settings/page.tsx` — Settings page with tabs (Roles, Members — add Organization tab)
- `web-ui/app/app/settings/roles/page.tsx` — Reference for sub-page pattern
- `web-ui/app/app/settings/members/page.tsx` — Reference for table + dialog pattern

### Tenant creation (Phase 15 output)
- `web-ui/app/create-org/page.tsx` — `useSession().update()` pattern for refreshing tenantId after change
- `web-ui/app/api/tenants/route.ts` — Tenant creation API (reference for tenant mutation pattern)

### RBAC (Phase 13 output)
- `web-ui/lib/rbac/authorize.ts` — authorize() function for permission checks
- `web-ui/lib/rbac/types.ts` — PredefinedRole type, role hierarchy

### Tenant isolation (Phase 14 output)
- `web-ui/lib/db/pg-config.ts` — `getTenantClient()` factory, TENANT_SCOPED_MODELS list (TenantConfig is already scoped)

### Requirements
- `.planning/REQUIREMENTS.md` — ORGW-01 through ORGW-04, STNG-01 through STNG-03

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `web-ui/components/sidebar.tsx`: Sidebar with `useSession()` — add org switcher to header area
- `web-ui/app/create-org/page.tsx`: Proven `session.update()` + redirect pattern for tenant change
- `web-ui/app/app/settings/page.tsx`: Tab structure — add Organization tab
- `web-ui/components/ui/`: DropdownMenu, Avatar, Select, Input, Button, Tabs, Dialog primitives
- `web-ui/lib/aws-config.ts`: AWS SDK client pattern — extend for S3 presigned URL generation
- TenantConfig model already exists in schema — no migration needed for settings storage

### Established Patterns
- `useSession()` + `update()` for client-side session refresh (Phase 15)
- `getTenantClient(tenantId)` for all tenant-scoped DB queries (Phase 14)
- `authorize(action, module)` for RBAC checks on API routes (Phase 13)
- Settings page tab navigation with sub-routes (Phase 16)
- Service layer static classes for business logic

### Integration Points
- `web-ui/components/sidebar.tsx`: Add org switcher component to sidebar header
- `web-ui/app/app/settings/page.tsx`: Add "Organization" tab
- `web-ui/app/app/settings/organization/page.tsx`: New org settings sub-page
- `web-ui/app/api/tenants/switch/route.ts`: New API for tenant switching
- `web-ui/app/api/tenants/settings/route.ts`: New API for tenant settings CRUD
- `web-ui/app/api/tenants/logo/route.ts`: New API for logo presigned URL generation
- `web-ui/lib/auth-options.ts`: Modify JWT/session callbacks to support active tenant switching
- `web-ui/lib/tenant-settings-service.ts`: New service for settings + logo management

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for implementation details not covered by decisions above.

</specifics>

<deferred>
## Deferred Ideas

- **Custom color theme per tenant** (BRND-01) — v3.x requirement, beyond logo
- **Super admin panel** (ADMIN-01–07) — deferred from Phase 15, separate future phase
- **Tenant suspension enforcement** (SUSP-01–04) — deferred from Phase 15, separate future phase
- **Billing/subscription tiers** — out of scope for v3.0

</deferred>

---

*Phase: 17-org-switcher-tenant-settings*
*Context gathered: 2026-04-01*

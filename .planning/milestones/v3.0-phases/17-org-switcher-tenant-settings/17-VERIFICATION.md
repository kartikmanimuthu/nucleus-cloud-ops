---
phase: 17-org-switcher-tenant-settings
verified: 2026-04-02T00:00:00Z
status: human_needed
score: 11/11 must-haves verified
human_verification:
  - test: "Multi-org dropdown in sidebar"
    expected: "User with 2+ orgs sees DropdownMenu with ChevronsUpDown icon; current org has Check mark; selecting another org switches session and reloads page data"
    why_human: "Requires live session with multiple UserTenantRole rows; visual rendering and session update() behavior cannot be verified statically"
  - test: "Single-org static display"
    expected: "User with exactly one org sees org name + avatar in sidebar header with no dropdown trigger"
    why_human: "Conditional rendering based on orgs.length at runtime; requires live session"
  - test: "Organization settings form save"
    expected: "Owner/Admin can change org name, timezone, notification toggles and click Save; values persist on page refresh"
    why_human: "Requires live DB write + re-fetch cycle; form state and success feedback need visual confirmation"
  - test: "Logo upload via presigned URL"
    expected: "Clicking logo area opens file picker; selecting PNG/JPG/SVG under 2MB uploads to S3 and displays new logo in sidebar and form"
    why_human: "Requires ASSETS_BUCKET_NAME env var and live AWS credentials; S3 presigned URL flow cannot be tested statically"
  - test: "Viewer/Member read-only enforcement"
    expected: "User with Member or Viewer role sees form fields disabled and Save button hidden; PUT /api/tenants/settings returns 403"
    why_human: "RBAC enforcement at UI layer depends on session.user.role at runtime"
---

# Phase 17: Org Switcher + Tenant Settings Verification Report

**Phase Goal:** Users can switch between orgs without re-login; tenant admins can configure org display settings and branding
**Verified:** 2026-04-02
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | activeTenantId column exists on AuthUser and is nullable | VERIFIED | `prisma/schema.prisma` line 510: `activeTenantId String?`; migration `20260401_add_active_tenant_id/migration.sql` applies `ALTER TABLE "auth_users" ADD COLUMN "active_tenant_id" TEXT` |
| 2 | Session callback reads activeTenantId to determine current tenant | VERIFIED | `auth-options.ts` lines 112-117: reads `(user as any).activeTenantId`, queries `userTenantRole.findFirst` with `tenantId: activeTenantId` before generic fallback |
| 3 | POST /api/tenants/switch validates membership then sets activeTenantId | VERIFIED | `switch/route.ts`: `userTenantRole.findFirst` membership check → 403 if missing → `authUser.update({ data: { activeTenantId: tenantId } })` |
| 4 | GET /api/tenants/my-orgs returns all orgs the user belongs to with name and logo | VERIFIED | `my-orgs/route.ts`: `userTenantRole.findMany` → `tenant.findMany` → `TenantConfigService.getConfig("org_logo")` per tenant → returns `{ id, name, slug, role, logoUrl }` |
| 5 | GET /api/tenants/settings returns org name, slug, timezone, and notification preferences | VERIFIED | `settings/route.ts` GET: calls `TenantSettingsService.getSettings` which merges `prisma.tenant.findUnique` (name, slug) + `TenantConfigService.getConfig("org_settings")` (timezone, notifications) |
| 6 | PUT /api/tenants/settings updates Tenant.name and TenantConfig org_settings | VERIFIED | `settings/route.ts` PUT: zod-validates body → `TenantSettingsService.updateSettings` → `prisma.tenant.update({ data: { name } })` + `TenantConfigService.saveConfig("org_settings", ...)` |
| 7 | POST /api/tenants/logo returns a presigned S3 PUT URL scoped to the tenant | VERIFIED | `logo/route.ts` POST: `getSignedUrl(s3, PutObjectCommand)` with key `logos/${tenantId}/${Date.now()}.${ext}`; validates PNG/JPG/SVG and 2MB limit |
| 8 | PUT /api/tenants/logo saves the S3 key in TenantConfig org_logo | VERIFIED | `logo/route.ts` PUT: `TenantSettingsService.saveLogo` → `TenantConfigService.saveConfig("org_logo", { key, url })` |
| 9 | Multi-org users see a dropdown; single-org users see static display | VERIFIED | `org-switcher.tsx`: `isMultiOrg = orgs.length > 1`; renders `DropdownMenu` when true, static `<div>` when false |
| 10 | Selecting a different org calls POST /api/tenants/switch then update() then router.refresh() | VERIFIED | `org-switcher.tsx` `handleSwitch`: `fetch("/api/tenants/switch", { method: "POST" })` → `await update()` → `router.refresh()` in that order |
| 11 | Organization settings form shows name, slug (read-only), timezone, notifications; RBAC enforced | VERIFIED | `organization-settings-form.tsx`: fetches `/api/tenants/settings` on mount; slug `<Input disabled>`; `Intl.supportedValuesOf("timeZone")` for timezone; 3 Switch toggles; `canEdit = role === "Owner" \|\| role === "Admin" \|\| isSuperAdmin`; Save button hidden when `!canEdit` |

**Score:** 11/11 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `prisma/schema.prisma` | activeTenantId field on AuthUser | VERIFIED | Line 510: `activeTenantId String?` inside AuthUser model |
| `prisma/migrations/20260401_add_active_tenant_id/migration.sql` | ALTER TABLE migration | VERIFIED | `ALTER TABLE "auth_users" ADD COLUMN "active_tenant_id" TEXT` |
| `web-ui/lib/auth-types.ts` | activeTenantId in User + AdapterUser | VERIFIED | Lines 21, 33: `activeTenantId?: string \| null` in both interfaces |
| `web-ui/lib/auth-options.ts` | Session callback honors activeTenantId | VERIFIED | activeTenantId check before generic findFirst fallback; JWT callback also updated |
| `web-ui/app/api/tenants/switch/route.ts` | POST endpoint | VERIFIED | Exports `POST`; membership check + `authUser.update` with `activeTenantId` |
| `web-ui/app/api/tenants/my-orgs/route.ts` | GET endpoint | VERIFIED | Exports `GET`; real DB queries for UTRs, tenants, logos |
| `web-ui/lib/tenant-settings-service.ts` | TenantSettingsService | VERIFIED | Exports `TenantSettingsService`, `OrgSettings`, `OrgLogo`; all 4 methods implemented |
| `web-ui/app/api/tenants/settings/route.ts` | GET + PUT | VERIFIED | Both handlers present; PUT calls `authorize("update", "Settings")` |
| `web-ui/app/api/tenants/logo/route.ts` | POST + PUT | VERIFIED | Both handlers; POST uses `getSignedUrl`; PUT saves via `TenantSettingsService.saveLogo` |
| `web-ui/components/settings/org-switcher.tsx` | OrgSwitcher component | VERIFIED | Exports `OrgSwitcher`; `collapsed` prop; multi/single-org branching; switch flow |
| `web-ui/components/sidebar.tsx` | OrgSwitcher integrated | VERIFIED | Imports `OrgSwitcher`; renders `<OrgSwitcher collapsed={collapsed} />` in header |
| `web-ui/app/app/settings/page.tsx` | Organization tab | VERIFIED | `TabsTrigger value="organization"` with `Building2` icon; `router.push("/app/settings/organization")` |
| `web-ui/app/app/settings/organization/page.tsx` | Organization sub-page | VERIFIED | Renders `<OrganizationSettingsForm />` |
| `web-ui/components/settings/organization-settings-form.tsx` | Settings form | VERIFIED | Full form: name, slug (disabled), timezone Select, 3 Switch toggles, logo upload, RBAC canEdit |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `switch/route.ts` | `prisma.authUser.update` | sets activeTenantId | WIRED | `prisma.authUser.update({ where: { id: session.user.id }, data: { activeTenantId: tenantId } })` |
| `auth-options.ts` | `user.activeTenantId` | session callback reads it | WIRED | `const activeTenantId = (user as any).activeTenantId` in both session + jwt callbacks |
| `settings/route.ts` | `TenantSettingsService` | getSettings / updateSettings | WIRED | `TenantSettingsService.getSettings(tenantId)` in GET; `TenantSettingsService.updateSettings(...)` in PUT |
| `logo/route.ts` | `@aws-sdk/s3-request-presigner` | getSignedUrl for presigned PUT | WIRED | `import { getSignedUrl } from "@aws-sdk/s3-request-presigner"` + `await getSignedUrl(s3, command, { expiresIn: 300 })` |
| `logo/route.ts` | `TenantSettingsService.saveLogo` | saves org_logo key | WIRED | `TenantSettingsService.saveLogo(tenantId, { key, url }, session.user.id)` → `TenantConfigService.saveConfig("org_logo", ...)` |
| `org-switcher.tsx` | `/api/tenants/switch` | fetch POST on org selection | WIRED | `fetch("/api/tenants/switch", { method: "POST", body: JSON.stringify({ tenantId }) })` |
| `org-switcher.tsx` | `/api/tenants/my-orgs` | fetch GET on mount | WIRED | `fetch("/api/tenants/my-orgs")` in `fetchOrgs` called from `useEffect` |
| `organization-settings-form.tsx` | `/api/tenants/settings` | fetch GET on mount, PUT on save | WIRED | `fetch("/api/tenants/settings")` in `useEffect`; `fetch("/api/tenants/settings", { method: "PUT" })` in `onSubmit` |
| `organization-settings-form.tsx` | `/api/tenants/logo` | POST presigned URL + PUT save key | WIRED | `fetch("/api/tenants/logo", { method: "POST" })` then `fetch("/api/tenants/logo", { method: "PUT" })` in `handleLogoUpload` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `org-switcher.tsx` | `orgs` (useState) | `fetch("/api/tenants/my-orgs")` → `userTenantRole.findMany` + `tenant.findMany` + `TenantConfigService.getConfig` | Yes — real DB queries | FLOWING |
| `organization-settings-form.tsx` | form values (react-hook-form) | `fetch("/api/tenants/settings")` → `TenantSettingsService.getSettings` → `prisma.tenant.findUnique` + `TenantConfigService.getConfig("org_settings")` | Yes — real DB queries | FLOWING |
| `my-orgs/route.ts` | `orgs` array | `prisma.userTenantRole.findMany` + `prisma.tenant.findMany` + `TenantConfigService.getConfig` per tenant | Yes — real DB queries | FLOWING |
| `settings/route.ts` | settings object | `TenantSettingsService.getSettings` → `prisma.tenant.findUnique` + `TenantConfigService.getConfig("org_settings")` | Yes — real DB queries | FLOWING |

### Behavioral Spot-Checks

Step 7b: SKIPPED — routes require live DB connection and AWS credentials; no runnable entry points available in static analysis context.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| ORGW-01 | 17-01, 17-03 | Header dropdown displays current org name and list of other orgs | SATISFIED | `org-switcher.tsx` fetches `/api/tenants/my-orgs`, renders DropdownMenu with all orgs |
| ORGW-02 | 17-01, 17-03 | Selecting a different org updates session tenantId via NextAuth | SATISFIED | `handleSwitch` → POST `/api/tenants/switch` → `authUser.update(activeTenantId)` → `await update()` refreshes session |
| ORGW-03 | 17-01, 17-03 | All data reloads scoped to the newly selected tenant after switch | SATISFIED | `router.refresh()` after `update()` triggers server component re-render with new session tenantId |
| ORGW-04 | 17-01, 17-03 | If user belongs to only one org, the switcher is hidden | SATISFIED | `isMultiOrg = orgs.length > 1`; single-org renders static display, no DropdownMenu |
| STNG-01 | 17-02, 17-03 | Tenant admin can update org display name, default timezone, and notification preferences | SATISFIED | PUT `/api/tenants/settings` + `OrganizationSettingsForm` with name/timezone/notifications fields |
| STNG-02 | 17-02, 17-03 | Tenant admin can upload org logo displayed in header/sidebar | SATISFIED | POST/PUT `/api/tenants/logo` presigned URL flow; `OrgSwitcher` renders `AvatarImage` with `logoUrl` |
| STNG-03 | 17-02 | Settings stored as JSON field on Tenant model; scoped to tenant | SATISFIED | `TenantConfigService.saveConfig("org_settings", ...)` stores JSON in `TenantConfig` table scoped by `tenantId` |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `org-switcher.tsx` | 87 | `return null` | Info | Guard clause only — fires when `currentOrg` is undefined (user has no active tenant). Not a stub; component renders full UI when data is present. |

No blockers or warnings found.

### Human Verification Required

#### 1. Multi-org dropdown in sidebar

**Test:** Log in as a user with 2+ UserTenantRole rows. Check sidebar header.
**Expected:** DropdownMenu with ChevronsUpDown icon appears; all orgs listed; current org has Check mark; selecting another org switches session and reloads page data without full page reload.
**Why human:** Requires live session with multiple tenant memberships; visual rendering and `update()` session refresh behavior cannot be verified statically.

#### 2. Single-org static display

**Test:** Log in as a user with exactly one UserTenantRole row. Check sidebar header.
**Expected:** Org name + avatar shown in header with no dropdown trigger or ChevronsUpDown icon.
**Why human:** Conditional rendering based on `orgs.length` at runtime; requires live session.

#### 3. Organization settings form save

**Test:** Navigate to Settings > Organization as Owner or Admin. Change org name, timezone, toggle a notification. Click Save Changes.
**Expected:** Success message appears; page refresh shows saved values.
**Why human:** Requires live DB write + re-fetch cycle; form state and success feedback need visual confirmation.

#### 4. Logo upload via presigned URL

**Test:** In Organization settings, click the logo area or "Change Logo" button. Select a PNG under 2MB.
**Expected:** Upload progress shown; new logo appears in form and sidebar header after upload completes.
**Why human:** Requires `ASSETS_BUCKET_NAME` env var and live AWS credentials; S3 presigned URL flow cannot be tested statically.

#### 5. Viewer/Member read-only enforcement

**Test:** Log in as a user with Member or Viewer role. Navigate to Settings > Organization.
**Expected:** All form fields are disabled; Save Changes button is not visible. Attempting PUT `/api/tenants/settings` directly returns 403.
**Why human:** RBAC enforcement at UI layer depends on `session.user.role` at runtime; API 403 requires live session with correct role.

### Gaps Summary

No gaps found. All 11 truths verified, all 14 artifacts exist and are substantive, all 9 key links are wired, and data flows through real DB queries in all dynamic components. The 5 human verification items are behavioral/visual checks that require a running dev server and live session — they are not blockers to phase completion but should be confirmed before shipping.

---

_Verified: 2026-04-02_
_Verifier: Claude (gsd-verifier)_

# Phase 17: Org Switcher + Tenant Settings - Research

**Researched:** 2026-04-01
**Domain:** NextAuth session switching, S3 presigned uploads, tenant settings UI
**Confidence:** HIGH

## Summary

Phase 17 adds two user-facing features: an org switcher in the sidebar for multi-org users, and an Organization settings tab for tenant admins. Both features build directly on infrastructure already in place — the session callback in `auth-options.ts`, `TenantConfigService`, the `TenantConfig` model, and the `UserTenantRole` table.

The core challenge is the "active tenant" persistence problem (D-07). The current session callback always resolves tenantId via `findFirst` on `UserTenantRole`, which returns the first row by insertion order. After a switch, `update()` re-runs the session callback — but without storing which tenant the user switched to, it will just return the same first tenant again. The solution is to add an `activeTenantId` column to `AuthUser` so the session callback can read the user's explicit choice. This requires a Prisma migration.

Logo upload uses `@aws-sdk/s3-request-presigner` which is already in `web-ui/package.json`. The presigned PUT URL pattern is the correct approach: API generates the URL, client uploads directly to S3, then stores the S3 key in `TenantConfig`. No new AWS SDK packages needed.

**Primary recommendation:** Add `activeTenantId String?` to `AuthUser`, update the session callback to read it, and implement `POST /api/tenants/switch` to set it. Everything else (settings form, logo upload, org switcher UI) follows established patterns.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: Org switcher lives in the sidebar header, above the navigation items
- D-02: Multi-org users see a dropdown listing all their orgs (queried from UserTenantRole). Clicking a different org triggers an API call to validate access, then `session.update()` + `router.refresh()`
- D-03: Single-org users see the org name displayed (no dropdown arrow, no switcher interaction)
- D-04: Org switcher shows org logo (if uploaded) + org name. Current org visually distinguished (checkmark or highlight)
- D-05: New API route `POST /api/tenants/switch` — accepts `tenantId`, verifies UserTenantRole, returns success. JWT/session callback must support switching active tenantId
- D-06: After switch: `update()` refreshes session, then `router.refresh()` triggers server component re-render. No full page reload
- D-07: "Active tenant" persistence — Claude's discretion on implementation. Key requirement: `getSessionTenantId()` returns the switched-to tenant after `update()`
- D-08: New "Organization" tab in /app/settings alongside Roles and Members tabs. Contains: org display name (editable), slug (read-only), default timezone (dropdown), notification preferences (toggles)
- D-09: Only Owner and Admin roles can edit tenant settings. Viewer and Member see read-only view. Enforced via `authorize('update', 'Settings')`
- D-10: Settings stored in TenantConfig table with configKey = 'org_settings'. JSON data field holds `{ timezone, notifications: { ... } }`
- D-11: Org display name update also updates `Tenant.name` directly. Timezone and notification prefs go in TenantConfig
- D-12: Logo upload via S3 presigned URL. New API route generates presigned PUT URL → client uploads directly to S3 → stores S3 key in TenantConfig (configKey = 'org_logo'). Served via CloudFront
- D-13: Logo appears in sidebar header next to org name. Also appears in org switcher dropdown for each org
- D-14: Accepted formats: PNG, JPG, SVG. Max size: 2MB. Displayed as 32x32 in sidebar, 24x24 in dropdown. Fallback: first letter of org name in colored circle
- D-15: Logo upload UI: click-to-upload area in Organization settings tab. Shows current logo with "Change" button overlay
- D-16: `router.refresh()` triggers server component re-render with new tenantId from session
- D-17: Client components using `useSession()` get updated session after `update()`. Client-side fetch hooks should re-validate

### Claude's Discretion
- Exact sidebar switcher component design and animation
- How to persist "active tenant" (AuthUser column vs session-only approach)
- Timezone dropdown implementation (IANA timezones or simplified list)
- Notification preferences structure (which notifications, toggle vs granular)
- S3 bucket selection for logo uploads (reuse existing bucket or dedicated)
- Logo image processing (resize on upload vs CSS-only scaling)
- Whether to show org slug in the switcher dropdown
- Error handling for failed org switch

### Deferred Ideas (OUT OF SCOPE)
- Custom color theme per tenant (BRND-01)
- Super admin panel (ADMIN-01–07)
- Tenant suspension enforcement (SUSP-01–04)
- Billing/subscription tiers
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ORGW-01 | Header dropdown displays current org name and list of other orgs the user belongs to | UserTenantRole query pattern; DropdownMenu primitive available |
| ORGW-02 | Selecting a different org updates session tenantId via NextAuth `update()` without full page reload | `activeTenantId` on AuthUser + session callback modification; `update()` pattern proven in Phase 15 |
| ORGW-03 | All data reloads scoped to newly selected tenant after org switch | `router.refresh()` re-runs server components; `getSessionTenantId()` returns new tenantId |
| ORGW-04 | If user belongs to only one org, the switcher is hidden | Count UserTenantRole rows; conditional render |
| STNG-01 | Tenant admin can update org display name, default timezone, and notification preferences | TenantConfigService.saveConfig() + direct Tenant.name update; Select + Switch primitives available |
| STNG-02 | Tenant admin can upload org logo displayed in header/sidebar | `@aws-sdk/s3-request-presigner` already in package.json; presigned PUT pattern |
| STNG-03 | Settings stored as JSON field on Tenant model; scoped to tenant-admin role | TenantConfig model with configKey='org_settings'; authorize('update','Settings') |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| next-auth | ^4.24.11 | Session update + callback | Already in use; `update()` proven in Phase 15 |
| @prisma/client | (project version) | DB queries for UserTenantRole, AuthUser, Tenant | Already in use; getTenantClient() pattern |
| @aws-sdk/s3-request-presigner | ^3.980.0 | Generate presigned PUT URLs for logo upload | Already in package.json |
| @aws-sdk/client-s3 | ^3.971.0 | S3 client for presigned URL generation | Already in package.json |
| react-hook-form + zod | ^7.54.1 / ^3.24.1 | Settings form validation | Already in use across the project |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Radix DropdownMenu | (project version) | Org switcher dropdown | Multi-org users only |
| Radix Select | (project version) | Timezone picker | Organization settings form |
| Radix Switch | (project version) | Notification preference toggles | Organization settings form |
| Radix Avatar | (project version) | Org logo display with fallback | Sidebar + dropdown |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| activeTenantId on AuthUser | Session-only (trigger param) | AuthUser column survives session expiry and re-login; session-only approach loses the switch on next login |
| S3 presigned PUT | Server-side upload proxy | Presigned PUT avoids routing large files through Next.js; already have the SDK |
| TenantConfig for org_settings | Tenant model JSON column | TenantConfig already exists and is tenant-scoped; no schema change needed for settings |

**Installation:** No new packages needed — all dependencies already in `web-ui/package.json`.

## Architecture Patterns

### Recommended Project Structure
```
web-ui/
├── app/
│   ├── api/
│   │   └── tenants/
│   │       ├── switch/route.ts          # POST — validate + set activeTenantId
│   │       ├── settings/route.ts        # GET/PUT — org settings (name, timezone, notifications)
│   │       └── logo/route.ts            # POST — generate presigned PUT URL
│   └── app/
│       └── settings/
│           └── organization/
│               └── page.tsx             # Organization settings sub-page
├── components/
│   └── settings/
│       ├── org-switcher.tsx             # Sidebar org switcher component
│       └── organization-settings-form.tsx  # Settings form
└── lib/
    └── tenant-settings-service.ts       # New service: org settings + logo CRUD
```

### Pattern 1: Active Tenant Persistence via AuthUser Column

**What:** Add `activeTenantId String?` to `AuthUser`. The session callback reads this field to determine which tenant to surface. `POST /api/tenants/switch` sets it.

**When to use:** Required for ORGW-02 — `update()` re-runs the session callback, which needs to know the user's chosen tenant.

**Schema addition (new migration):**
```prisma
model AuthUser {
  // ... existing fields ...
  activeTenantId String?   // null = use first UserTenantRole (default behavior)
}
```

**Session callback modification in `auth-options.ts`:**
```typescript
async session({ session, user }) {
    // Prefer activeTenantId if set, otherwise fall back to findFirst
    const activeTenantId = (user as any).activeTenantId;
    let utr;
    if (activeTenantId) {
        utr = await prisma.userTenantRole.findFirst({
            where: { userId: user.id, tenantId: activeTenantId },
        });
    }
    if (!utr) {
        utr = await prisma.userTenantRole.findFirst({
            where: { userId: user.id },
        });
    }
    // ... rest of session callback unchanged
}
```

**Switch API route:**
```typescript
// POST /api/tenants/switch
export async function POST(req: NextRequest) {
    const session = await getAuthSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });

    const { tenantId } = await req.json();
    const prisma = getPrismaClient();

    // Verify user actually belongs to this tenant
    const utr = await prisma.userTenantRole.findFirst({
        where: { userId: session.user.id, tenantId },
    });
    if (!utr) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Persist the active tenant choice
    await prisma.authUser.update({
        where: { id: session.user.id },
        data: { activeTenantId: tenantId },
    });

    return NextResponse.json({ success: true });
}
```

**Client-side switch flow:**
```typescript
// In org-switcher.tsx
const handleSwitch = async (tenantId: string) => {
    await fetch('/api/tenants/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId }),
    });
    await update();       // re-runs session callback → new tenantId in session
    router.refresh();     // server components re-render with new tenant scope
};
```

### Pattern 2: Org Switcher Component (Conditional Render)

**What:** Sidebar component that queries the user's orgs and conditionally renders a dropdown (multi-org) or static display (single-org).

**When to use:** Always rendered in sidebar header; internally decides which variant to show.

```typescript
// org-switcher.tsx — "use client"
// Fetch /api/tenants/my-orgs on mount → array of { id, name, logoUrl }
// If orgs.length === 1: render static name + logo (no dropdown)
// If orgs.length > 1: render DropdownMenu with checkmark on current org
```

New API needed: `GET /api/tenants/my-orgs` — returns all UserTenantRole rows for the current user, joined with Tenant name + logo from TenantConfig.

### Pattern 3: S3 Presigned PUT for Logo Upload

**What:** Two-step upload: (1) client requests presigned URL from API, (2) client PUTs file directly to S3, (3) client notifies API to save the S3 key.

```typescript
// POST /api/tenants/logo — generate presigned URL
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const key = `logos/${tenantId}/${Date.now()}.${ext}`;
const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: process.env.ASSETS_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
    ContentLength: size,  // enforce 2MB limit server-side
}), { expiresIn: 300 });

// After client uploads, PUT /api/tenants/logo with { key }
// → TenantConfigService.saveConfig('org_logo', { key, url: `${CDN_URL}/${key}` }, tenantId)
```

### Pattern 4: Organization Settings Form

**What:** react-hook-form + zod form in the Organization settings sub-page. GET loads current settings, PUT saves them.

```typescript
// GET /api/tenants/settings → { name, slug, timezone, notifications }
// PUT /api/tenants/settings → validate + update Tenant.name + TenantConfig('org_settings')

const orgSettingsSchema = z.object({
    name: z.string().min(1).max(100),
    timezone: z.string(),  // IANA timezone string
    notifications: z.object({
        scheduleExecutions: z.boolean(),
        memberInvites: z.boolean(),
        systemAlerts: z.boolean(),
    }),
});
```

Timezone dropdown: use `Intl.supportedValuesOf('timeZone')` — returns 418 IANA timezones, available in Node 20+ (confirmed). Filter to common ones or use full list with search via Radix Command/Combobox.

### Pattern 5: Settings Tab Navigation (existing pattern)

The settings page uses `onClick={() => router.push('/app/settings/roles')}` on TabsTrigger for sub-page navigation. Add Organization tab the same way:

```typescript
<TabsTrigger
    value="organization"
    className="data-[state=active]:bg-background"
    onClick={() => router.push("/app/settings/organization")}
>
    <Building2 className="mr-2 h-4 w-4" />
    Organization
</TabsTrigger>
```

### Anti-Patterns to Avoid

- **Storing activeTenantId in JWT only:** Database sessions are in use (strategy: "database"). The JWT callback runs on initial sign-in only — `update()` does NOT re-run the JWT callback with database strategy. Only the session callback runs on `update()`. Store state in the DB (AuthUser), not the JWT.
- **Calling `router.refresh()` before `update()` completes:** `update()` is async. Always `await update()` before `router.refresh()` or the server components will re-render with the old tenantId.
- **Using getTenantClient() in the switch API:** The switch route needs to update `AuthUser.activeTenantId` which is NOT a tenant-scoped model. Use `getPrismaClient()` directly.
- **Skipping the UserTenantRole membership check in switch API:** Always verify the user has a row in UserTenantRole for the requested tenantId before setting activeTenantId. A user could craft a request with any tenantId.
- **Fetching org list on every render:** Cache the org list in component state; only re-fetch after a switch or membership change.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Presigned S3 URL generation | Custom URL signing | `@aws-sdk/s3-request-presigner` | Handles SigV4 signing, expiry, content-type enforcement |
| Timezone list | Hardcoded array | `Intl.supportedValuesOf('timeZone')` | Node 20+ built-in; always current; 418 entries |
| File type validation | MIME sniffing | ContentType in presigned URL + client-side accept attribute | Server enforces via S3 policy; client UX via `<input accept>` |
| Session state after switch | Custom state management | NextAuth `update()` + `router.refresh()` | Proven pattern from Phase 15; handles all session consumers |

**Key insight:** The presigned URL pattern means zero file bytes pass through the Next.js process — S3 handles the upload directly. This is critical for ECS Fargate where memory is shared.

## Common Pitfalls

### Pitfall 1: Database Strategy + update() Behavior
**What goes wrong:** Developer assumes `update()` re-runs the JWT callback (like JWT strategy does). With `strategy: "database"`, only the `session` callback runs on `update()`. The JWT callback only runs on initial sign-in.
**Why it happens:** NextAuth docs describe both strategies; easy to conflate.
**How to avoid:** The session callback in `auth-options.ts` already uses `user` (not `token`) — this is correct for database strategy. The `activeTenantId` must be readable from the `user` object passed to the session callback, which means it must be on `AuthUser` in the DB.
**Warning signs:** `update()` completes but `session.user.tenantId` doesn't change.

### Pitfall 2: x-tenant-id Header After Switch
**What goes wrong:** Middleware injects `x-tenant-id` from `token.tenantId` (JWT). After a switch, the JWT is NOT updated (database strategy). So `x-tenant-id` in the header still has the old tenantId until the JWT expires and is re-issued.
**Why it happens:** Middleware reads the JWT token, not the database session.
**How to avoid:** API routes should use `getSessionTenantId()` (reads from database session) rather than trusting the `x-tenant-id` header for security-sensitive operations. The header is a convenience for non-auth middleware, not a security boundary.
**Warning signs:** API routes return data from the old tenant after a switch.

### Pitfall 3: TenantConfig Scoping for Logo
**What goes wrong:** `getTenantClient()` auto-injects `tenantId` on TenantConfig queries. If the logo API uses `getTenantClient()` correctly, the `org_logo` config is automatically scoped. But if `getPrismaClient()` is used by mistake, a logo query without explicit `tenantId` will return any tenant's logo.
**Why it happens:** Two client factories with different behaviors.
**How to avoid:** Always use `getTenantClient(tenantId)` for TenantConfig operations. The `TenantConfigService` already does this via the repository factory.

### Pitfall 4: S3 Key Collision Between Tenants
**What goes wrong:** Logo keys like `logos/logo.png` collide across tenants.
**Why it happens:** Missing tenant scoping in the S3 key.
**How to avoid:** Always prefix with tenantId: `logos/${tenantId}/${timestamp}.${ext}`. This also makes it easy to delete old logos when a new one is uploaded.

### Pitfall 5: Stale Org List in Switcher After Invitation Acceptance
**What goes wrong:** User accepts an invitation to a second org in another tab. The org switcher in the first tab still shows only one org (no switcher visible).
**Why it happens:** Org list is fetched once on mount and cached in state.
**How to avoid:** This is acceptable for v3.0 — a page refresh will show the new org. Document as known limitation. Do not add polling.

### Pitfall 6: Auth-types.ts Missing activeTenantId
**What goes wrong:** TypeScript errors when accessing `user.activeTenantId` in the session callback because `AdapterUser` doesn't declare it.
**Why it happens:** `auth-types.ts` augments the NextAuth types; new fields need to be declared there.
**How to avoid:** Add `activeTenantId?: string | null` to both the `User` and `AdapterUser` interface augmentations in `auth-types.ts`.

## Code Examples

### Fetching User's Orgs with Tenant Names
```typescript
// GET /api/tenants/my-orgs
// Source: established UserTenantRole query pattern (Phase 13/14)
const prisma = getPrismaClient();
const utrs = await prisma.userTenantRole.findMany({
    where: { userId: session.user.id },
});
const tenantIds = utrs.map(u => u.tenantId);
const tenants = await prisma.tenant.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true, name: true },
});
// Merge with logo from TenantConfig (separate query per tenant or batch)
```

### Presigned PUT URL Generation
```typescript
// Source: @aws-sdk/s3-request-presigner official pattern
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const command = new PutObjectCommand({
    Bucket: process.env.ASSETS_BUCKET_NAME!,
    Key: `logos/${tenantId}/${Date.now()}.${ext}`,
    ContentType: contentType,  // 'image/png' | 'image/jpeg' | 'image/svg+xml'
});
const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
```

### Client-Side Logo Upload
```typescript
// In organization-settings-form.tsx
const uploadLogo = async (file: File) => {
    // 1. Get presigned URL
    const res = await fetch('/api/tenants/logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: file.type, size: file.size, ext: file.name.split('.').pop() }),
    });
    const { url, key } = await res.json();

    // 2. Upload directly to S3
    await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });

    // 3. Save key to TenantConfig
    await fetch('/api/tenants/logo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
    });
};
```

### Org Switcher Conditional Render
```typescript
// org-switcher.tsx — "use client"
// orgs fetched from /api/tenants/my-orgs
if (orgs.length <= 1) {
    return (
        <div className="flex items-center gap-2 px-2 py-1">
            <OrgAvatar org={currentOrg} size={32} />
            {!collapsed && <span className="font-medium text-sm truncate">{currentOrg.name}</span>}
        </div>
    );
}
// Multi-org: DropdownMenu with checkmark on active org
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| JWT strategy session switching | Database strategy + session callback | Phase 12 | `update()` re-runs session callback, not JWT callback — activeTenantId must be in DB |
| CASL authorize | Custom authorize() | Phase 13 | Use `authorize('update', 'Settings')` for settings write protection |
| DynamoDB TenantConfig | PostgreSQL TenantConfig via TenantConfigService | Phase 14 | TenantConfigService.saveConfig() is the correct write path |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| @aws-sdk/s3-request-presigner | Logo upload | ✓ | ^3.980.0 | — |
| @aws-sdk/client-s3 | Logo upload | ✓ | ^3.971.0 | — |
| Intl.supportedValuesOf | Timezone list | ✓ | Node 20 built-in (418 timezones) | — |
| ASSETS_BUCKET_NAME env var | Logo S3 bucket | Unknown | — | Must be set or use existing CDK bucket name |

**Missing dependencies with no fallback:**
- `ASSETS_BUCKET_NAME` env var — must be confirmed. Check `web-ui/.env.local.example` or CDK outputs for the correct bucket name. The planner should add a task to verify/document this env var.

## Open Questions

1. **Which S3 bucket for logos?**
   - What we know: `@aws-sdk/client-s3` is in package.json; CDK provisions S3 buckets in ComputeStack
   - What's unclear: Which bucket name/env var to use for logo storage; whether a dedicated bucket or existing one
   - Recommendation: Reuse the existing assets/static bucket from CDK. Planner should add a task to read `lib/computeStack.ts` (or Pulumi equivalent) to identify the correct bucket and env var name.

2. **CloudFront URL for serving logos**
   - What we know: CloudFront is in front of the app; CDK/Pulumi provisions a distribution
   - What's unclear: Whether the S3 bucket is behind CloudFront or requires a separate origin
   - Recommendation: Store the full CloudFront URL in TenantConfig alongside the S3 key. If CloudFront isn't available for the bucket, serve via a signed S3 URL or a proxy API route as fallback.

3. **Notification preferences structure**
   - What we know: D-10 specifies `{ timezone, notifications: { ... } }` in TenantConfig
   - What's unclear: Which specific notification types to expose (schedule executions, member invites, system alerts?)
   - Recommendation: Start with three toggles: `scheduleExecutions`, `memberInvites`, `systemAlerts`. These map to the existing audit event types and are the most actionable for a cloud ops platform.

## Sources

### Primary (HIGH confidence)
- Direct code inspection: `web-ui/lib/auth-options.ts` — session callback behavior with database strategy confirmed
- Direct code inspection: `prisma/schema.prisma` — TenantConfig, AuthUser, UserTenantRole models confirmed
- Direct code inspection: `web-ui/lib/tenant-config-service.ts` — TenantConfigService.saveConfig() API confirmed
- Direct code inspection: `web-ui/package.json` — `@aws-sdk/s3-request-presigner` ^3.980.0 confirmed present
- Direct code inspection: `web-ui/lib/db/pg-config.ts` — getTenantClient() behavior, TENANT_SCOPED_MODELS confirmed
- Direct code inspection: `web-ui/components/sidebar.tsx` — sidebar structure, useSession() usage confirmed
- Direct code inspection: `web-ui/app/create-org/page.tsx` — `update()` + `router.push()` pattern confirmed
- Node.js runtime check: `Intl.supportedValuesOf('timeZone')` returns 418 entries on Node 20

### Secondary (MEDIUM confidence)
- NextAuth v4 docs: database strategy session callback behavior (update() re-runs session callback, not JWT callback)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages confirmed in package.json; no new installs needed
- Architecture: HIGH — session callback, TenantConfig, and presigned URL patterns all verified against actual code
- Pitfalls: HIGH — JWT vs database strategy behavior verified by reading auth-options.ts directly

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (stable libraries; NextAuth v4 is stable)

---
phase: quick-260403-seb
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - web-ui/app/app/settings/members/page.tsx
  - web-ui/components/settings/organization-settings-form.tsx
  - web-ui/app/api/tenants/logo/route.ts
  - scripts/generate-env.ts
  - web-ui/.env.local.example
autonomous: true
requirements: [BUG-CUSTOM-ROLES, BUG-LOGO-UPLOAD]

must_haves:
  truths:
    - "Custom roles created in Settings > Roles appear in the invite member dropdown"
    - "Logo upload fails visibly (error message shown) when S3 PUT returns non-2xx"
    - "Logo route returns 500 with clear message when ASSETS_BUCKET_NAME is not set"
  artifacts:
    - path: "web-ui/app/app/settings/members/page.tsx"
      provides: "Fetches custom roles from /api/settings/roles and merges with predefined roles"
    - path: "web-ui/components/settings/organization-settings-form.tsx"
      provides: "Checks s3Res.ok before proceeding to save step"
    - path: "web-ui/app/api/tenants/logo/route.ts"
      provides: "Guards against missing ASSETS_BUCKET_NAME env var"
  key_links:
    - from: "web-ui/app/app/settings/members/page.tsx"
      to: "/api/settings/roles"
      via: "fetch on mount"
      pattern: "fetch.*api/settings/roles"
---

<objective>
Fix two bugs: (1) custom roles never appear in the invite member dropdown because the page hardcodes predefined roles only; (2) logo upload fails silently when the S3 PUT returns a non-2xx response or when ASSETS_BUCKET_NAME is not configured.

Purpose: Both bugs block core multi-tenancy UX — custom RBAC roles are unusable for invitations, and org branding setup gives no feedback on failure.
Output: Members page fetches and merges custom roles; logo upload surfaces errors at each failure point; env var missing returns a clear 500.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fetch and merge custom roles in members page invite dropdown</name>
  <files>web-ui/app/app/settings/members/page.tsx</files>
  <action>
Add a `customRoles` state (`useState<string[]>([])`). In a new `fetchRoles` callback (wrapped in `useCallback`), call `GET /api/settings/roles`. The response shape is `{ success: true, data: { predefined: [...], custom: [{ id, name, level, ... }] } }`. Extract `data.custom.map(r => r.name)` and set into `customRoles` state. Call `fetchRoles()` inside the existing `useEffect` alongside `fetchMembers` and `fetchInvitations`.

Update the `availableRoles` derivation (currently line 134) to merge predefined and custom:

```typescript
const predefinedFiltered = ALL_ROLES.filter((r) => (ROLE_HIERARCHY[r] ?? 0) <= userLevel);
const customFiltered = customRoles.filter((_, i) => {
    // custom roles fetched from API already carry level; store level alongside name
});
```

Actually, store custom roles as `{ name: string; level: number }[]` so the level filter can be applied. Change state to `useState<{ name: string; level: number }[]>([])`. Map `data.custom` to `{ name: r.name, level: r.level }`. Then:

```typescript
const predefinedFiltered = ALL_ROLES.filter((r) => (ROLE_HIERARCHY[r] ?? 0) <= userLevel);
const customFiltered = customRoles.filter((r) => r.level <= userLevel).map((r) => r.name);
const availableRoles = [...predefinedFiltered, ...customFiltered];
```

If the roles fetch fails, log the error and leave `customRoles` as `[]` (non-blocking — predefined roles still work). Do not show an error banner for this secondary fetch.
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy/web-ui && npm run lint -- --max-warnings=0 2>&1 | tail -5</automated>
  </verify>
  <done>Members page fetches /api/settings/roles on mount; custom roles with level <= userLevel appear in availableRoles passed to InviteMemberDialog; predefined roles still work if fetch fails.</done>
</task>

<task type="auto">
  <name>Task 2: Fix logo upload silent failure and missing env var guard</name>
  <files>
    web-ui/components/settings/organization-settings-form.tsx
    web-ui/app/api/tenants/logo/route.ts
    scripts/generate-env.ts
    web-ui/.env.local.example
  </files>
  <action>
**organization-settings-form.tsx** — After the S3 PUT (line 156), capture the response and check `ok`:

```typescript
const s3Res = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
if (!s3Res.ok) {
    setLogoError("Logo upload failed. Check your storage configuration.");
    return;
}
```

**web-ui/app/api/tenants/logo/route.ts** — At the top of the `POST` handler, before any S3 calls, add:

```typescript
if (!process.env.ASSETS_BUCKET_NAME) {
    return NextResponse.json(
        { error: "Logo storage not configured (ASSETS_BUCKET_NAME missing)" },
        { status: 500 }
    );
}
```

**scripts/generate-env.ts** — In the S3 buckets section (after line 104), add an optional mapping:

```typescript
if (o.assetsBucketName) set("ASSETS_BUCKET_NAME", o.assetsBucketName);
```

**web-ui/.env.local.example** — After the `CHECKPOINT_S3_BUCKET` line, add:

```
# ASSETS_BUCKET_NAME=your-assets-bucket  # Required for org logo upload
```
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy/web-ui && npm run lint -- --max-warnings=0 2>&1 | tail -5</automated>
  </verify>
  <done>S3 PUT response is checked; non-2xx shows error and aborts save step. POST /api/tenants/logo returns 500 with descriptive message when ASSETS_BUCKET_NAME is unset. generate-env.ts maps assetsBucketName if present. .env.local.example documents the var.</done>
</task>

</tasks>

<verification>
- `npm run lint` passes with no errors in web-ui
- Members page: custom roles state initialized, fetchRoles called on mount, availableRoles merges predefined + custom filtered by level
- Logo route: ASSETS_BUCKET_NAME guard present before S3 client instantiation
- org-settings-form: s3Res.ok checked before proceeding to PUT /api/tenants/logo
</verification>

<success_criteria>
- Custom roles created via Settings > Roles appear in the invite dropdown for users with sufficient level
- Logo upload shows "Logo upload failed" immediately when S3 PUT returns non-2xx (no silent proceed)
- Visiting Settings > Organization with ASSETS_BUCKET_NAME unset: presign step returns 500 with "Logo storage not configured" message visible to the user
</success_criteria>

<output>
After completion, create `.planning/quick/260403-seb-fix-custom-roles-not-appearing-in-invite/260403-seb-SUMMARY.md`
</output>

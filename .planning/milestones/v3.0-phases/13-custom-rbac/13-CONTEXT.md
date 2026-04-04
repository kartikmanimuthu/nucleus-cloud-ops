# Phase 13: Custom RBAC - Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace CASL with a custom role/permission system. Static ROLE_PERMISSIONS map for 4 predefined roles (Owner, Admin, Member, Viewer) across 5 modules (Accounts, Schedules, AI Ops, Inventory, Settings) with CRUD actions. Custom role creation per tenant (DB-stored, checkbox matrix UI). Migrate all ~20 API routes via per-route feature flags. Remove @casl/ability after full migration.

</domain>

<decisions>
## Implementation Decisions

### Permission map design
- **D-01:** Static + DB hybrid — predefined roles (Owner, Admin, Member, Viewer) hardcoded in a static `ROLE_PERMISSIONS` object. Custom roles stored in DB with the same shape. `authorize()` checks static first, falls back to DB for custom roles.
- **D-02:** 5 modules: Accounts, Schedules, AI Ops (Agent + KnowledgeBase collapsed), Inventory, Settings
- **D-03:** CRUD actions only (create, read, update, delete) per module. Schedule execution maps to `update`. Audit export maps to `read`.
- **D-04:** 4 predefined roles with strict hierarchy: Owner (full CRUD all modules) > Admin (full CRUD except Settings delete) > Member (CRU on Accounts/Schedules/AI Ops/Inventory, R on Settings) > Viewer (R only on all)

### Migration strategy
- **D-05:** Wrapper with per-route feature flags — new `authorize()` checks new RBAC first. If `USE_NEW_RBAC_{ROUTE}` flag is off, falls back to CASL. Migrate routes one-by-one, flip flags. Delete @casl/ability when all flags are on.
- **D-06:** Clean rename of all roles — rename to Owner/Admin/Member/Viewer everywhere. Update `UserTenantRole.role` column values via migration script. Clean break from Cognito group naming (SuperAdmins → handled by isSuperAdmin flag from Phase 12).

### Custom role mechanics
- **D-07:** Checkbox matrix UI for permission picker — rows = 5 modules, columns = CRUD actions. Tenant admin checks boxes to build a custom permission set.
- **D-08:** Max 10 custom roles per tenant. Predefined roles (Owner/Admin/Member/Viewer) can't be edited or deleted. Custom roles can be deleted — users on deleted role get downgraded to Viewer.

### Privilege escalation rules
- **D-09:** Numeric hierarchy levels: Owner (4) > Admin (3) > Member (2) > Viewer (1). You can only assign roles at or below your own level. Owner can assign any role. Admin can assign Admin/Member/Viewer. Member can't assign roles.
- **D-10:** Custom roles auto-leveled by permission count — custom roles get the same numeric level as the predefined role they most closely match. Owner-level custom roles can only be created by Owners.

### Claude's Discretion
- Feature flag naming convention and storage mechanism (env vars vs DB config)
- Exact permission matrix edge cases (e.g., which Settings sub-actions Admin gets)
- Custom role DB schema design (Prisma model shape)
- Permission caching strategy (per-request vs short TTL)
- Migration script ordering and rollback approach
- Test strategy for permission matrix coverage

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Current RBAC implementation (to be replaced)
- `web-ui/lib/rbac/authorize.ts` — Current CASL authorize() function — new authorize() must match this signature
- `web-ui/lib/rbac/abilities.ts` — Current permission matrix — reference for migration parity
- `web-ui/lib/rbac/types.ts` — Actions, Subjects, Role types — will be rewritten
- `web-ui/lib/rbac/server-ability.ts` — Current getServerAbility() with DEFAULT_TENANT_ID fallback
- `web-ui/lib/rbac/role-service.ts` — getUserTenantRole() from DynamoDB

### API routes using authorize() (~20 routes to migrate)
- `web-ui/app/api/accounts/route.ts` — Account CRUD
- `web-ui/app/api/schedules/route.ts` — Schedule CRUD
- `web-ui/app/api/audit/route.ts` — Audit log read
- `web-ui/app/api/chat/route.ts` — Agent access
- `web-ui/app/api/knowledge-base/` — KB CRUD
- `web-ui/app/api/threads/` — Thread access
- `web-ui/app/api/admin/users/` — User/role management

### Auth foundation (Phase 12 output)
- `web-ui/lib/auth-options.ts` — Session normalization with role field
- `web-ui/lib/auth-session.ts` — getSessionTenantId(), assertSuperAdmin()
- `web-ui/middleware.ts` — x-tenant-id injection, admin route guard

### Database schema
- `web-ui/prisma/schema.prisma` — UserTenantRole model, will need CustomRole model added

### Project context
- `.planning/REQUIREMENTS.md` — RBAC-01 through RBAC-07
- `.planning/PROJECT.md` — Key decision: remove CASL, build custom RBAC

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `web-ui/lib/rbac/authorize.ts`: Same function signature (`authorize(action, subject)` → `NextResponse | null`) should be preserved for minimal route changes
- `web-ui/lib/rbac/types.ts`: Actions/Subjects type definitions — rewrite with new module-based types
- `web-ui/lib/rbac/abilities.ts`: Full permission matrix for 4 roles — use as reference for new static ROLE_PERMISSIONS
- `web-ui/components/ui/`: Checkbox, Table, Dialog primitives for custom role management UI

### Established Patterns
- `authorize()` returns `NextResponse | null` — every API route checks `if (authError) return authError`
- Feature flags via repository-factory.ts pattern (USE_PG_*) — same pattern for USE_NEW_RBAC_* flags
- Session provides `role` field from Phase 12 — new authorize() reads role from session directly (no more Cognito group lookup)

### Integration Points
- `web-ui/lib/rbac/authorize.ts`: Rewrite internals, keep signature
- `web-ui/lib/rbac/types.ts`: New module-based types replace CASL types
- `web-ui/prisma/schema.prisma`: Add CustomRole model with permissions JSON column
- Every API route calling `authorize()`: No change needed if signature preserved — just flip feature flag
- `web-ui/app/app/settings/`: Custom role management UI (new page)

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

*Phase: 13-custom-rbac*
*Context gathered: 2026-03-31*

# Phase 13: Custom RBAC - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-31
**Phase:** 13-custom-rbac
**Areas discussed:** Permission map design, Migration strategy, Custom role mechanics, Privilege escalation rules

---

## Permission map design

### Q1: How should predefined and custom roles coexist?

| Option | Description | Selected |
|--------|-------------|----------|
| Static + DB hybrid | Predefined roles hardcoded in static object. Custom roles in DB with same shape. authorize() checks static first, falls back to DB. | ✓ |
| All DB-driven | All roles in DB. Predefined seeded on tenant creation, marked non-deletable. | |
| Static only | No real custom roles — just display name aliases for predefined roles. | |

**User's choice:** Static + DB hybrid
**Notes:** None

### Q2: What modules should the permission matrix cover?

| Option | Description | Selected |
|--------|-------------|----------|
| 5 modules | Accounts, Schedules, AI Ops (Agent + KB), Inventory, Settings. Matches RBAC-02. | ✓ |
| Keep current 10 subjects | All current CASL subjects kept separate. More granular but complex. | |
| 5 modules, extensible | Start with 5, allow splitting later. | |

**User's choice:** 5 modules
**Notes:** None

### Q3: What actions should the permission system support per module?

| Option | Description | Selected |
|--------|-------------|----------|
| CRUD only | create, read, update, delete. Schedule execution maps to update. | ✓ |
| CRUD + execute + export | CRUD plus distinct execute and export permissions. | |
| CRUD + manage wildcard | CRUD plus manage grants all actions on a module. | |

**User's choice:** CRUD only
**Notes:** None

### Q4: What should the 4 predefined roles be?

| Option | Description | Selected |
|--------|-------------|----------|
| Owner > Admin > Member > Viewer | Owner (full CRUD all), Admin (full CRUD except Settings delete), Member (CRU most, R Settings), Viewer (R only). | ✓ |
| Keep current role names | TenantAdmin/TenantOperator/TenantViewer + SuperAdmin. Rename in UI only. | |
| You decide | Claude picks sensible matrix. | |

**User's choice:** Owner > Admin > Member > Viewer
**Notes:** None

---

## Migration strategy

### Q5: How should the CASL-to-new-RBAC cutover work?

| Option | Description | Selected |
|--------|-------------|----------|
| Wrapper with per-route flags | New authorize() checks new RBAC first. Per-route USE_NEW_RBAC_{ROUTE} flag falls back to CASL when off. | ✓ |
| Single global flag | One USE_NEW_RBAC flag for all routes. Simpler but riskier. | |
| Big bang | Rewrite all routes at once. No flags. | |

**User's choice:** Wrapper with per-route flags
**Notes:** Aligns with STATE.md decision from roadmap creation.

### Q6: How to clean up role naming inconsistencies?

| Option | Description | Selected |
|--------|-------------|----------|
| Clean rename | Rename to Owner/Admin/Member/Viewer everywhere. DB migration script. | ✓ |
| DB keeps old, UI shows new | Map old names to new in UI only. Less migration risk. | |
| You decide | Claude picks cleanest approach. | |

**User's choice:** Clean rename
**Notes:** None

---

## Custom role mechanics

### Q7: How should tenant admins define permissions for a custom role?

| Option | Description | Selected |
|--------|-------------|----------|
| Checkbox matrix | Rows = 5 modules, columns = CRUD actions. Visual, no ambiguity. | ✓ |
| Clone + modify | Start from predefined role template, toggle permissions. | |
| You decide | Claude picks best UX. | |

**User's choice:** Checkbox matrix
**Notes:** None

### Q8: What limits on custom roles, and deletion behavior?

| Option | Description | Selected |
|--------|-------------|----------|
| 10 max, downgrade to Viewer | Max 10 custom roles per tenant. Predefined can't be edited/deleted. Deleted role → users become Viewer. | ✓ |
| Unlimited, block on delete | No limit. Deleted role blocks users until reassigned. | |
| You decide | Claude picks sensible limits. | |

**User's choice:** 10 max, downgrade to Viewer
**Notes:** None

---

## Privilege escalation rules

### Q9: How should role hierarchy be enforced?

| Option | Description | Selected |
|--------|-------------|----------|
| Numeric levels | Owner (4) > Admin (3) > Member (2) > Viewer (1). Assign at or below own level. | ✓ |
| Strictly below only | Same levels but Admin can only assign Member/Viewer, not Admin. | |
| You decide | Claude picks hierarchy rules. | |

**User's choice:** Numeric levels
**Notes:** None

### Q10: How should custom roles fit into the hierarchy?

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-level by permission count | Custom roles get level matching closest predefined role. Owner-level custom roles only by Owners. | ✓ |
| Admin picks level manually | Explicit level selection in UI. More control, more complexity. | |
| All custom = Member level | All custom roles are level 2. Simplest but limiting. | |

**User's choice:** Auto-level by permission count
**Notes:** None

---

## Claude's Discretion

- Feature flag naming convention and storage
- Permission matrix edge cases
- Custom role DB schema design
- Permission caching strategy
- Migration script ordering
- Test strategy

## Deferred Ideas

None — discussion stayed within phase scope.

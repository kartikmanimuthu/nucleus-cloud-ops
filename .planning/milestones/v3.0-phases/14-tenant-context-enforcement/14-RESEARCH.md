# Phase 14: Tenant Context Enforcement - Research

**Researched:** 2026-04-01
**Domain:** Prisma Client Extensions, multi-tenant isolation, LangGraph thread scoping
**Confidence:** HIGH

## Summary

Phase 14 enforces structural tenant isolation across four layers: the Prisma ORM client (scoped factory via Extensions), the service layer (DEFAULT_TENANT_ID removal), Lambda functions (scheduler tenant iteration + discovery tenant tagging), and LangGraph persistence (namespaced thread IDs + PostgresChatHistory bug fix).

The codebase is well-prepared: every Prisma model already has `tenantId` with `@@index([tenantId])`, `getSessionTenantId()` already throws on missing tenantId, and `pg-service.ts` in the scheduler already accepts tenantId as a parameter. The work is largely mechanical wiring — the patterns are established, the gaps are specific and enumerable.

The one schema change needed is adding `status` to the Tenant model (for scheduler suspended-tenant filtering). The most subtle bug is in `persistence.ts` where `PostgresChatHistory` stores `userId` in the `tenantId` column — this must be fixed before the scoped client is enforced or chat history queries will break.

**Primary recommendation:** Implement in four sequential plans: (1) scoped Prisma client factory + Tenant status migration, (2) DEFAULT_TENANT_ID removal across service layer, (3) Lambda isolation (scheduler + discovery), (4) LangGraph thread isolation + two-tenant test.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: `getTenantClient(tenantId)` factory uses Prisma Client Extensions (`$extends`) wrapping the existing singleton from `getPrismaClient()` in `pg-config.ts`. Injects `WHERE tenant_id = $1` on every `findMany`, `findFirst`, `create`, `update`, `delete`, and `count` operation automatically.
- D-02: Raw SQL queries (`$executeRaw`, `$queryRawUnsafe`) are NOT intercepted by Extensions — every raw query in the codebase (persistence.ts vector upsert, inventory/postgres.ts vector search) must be manually scoped with explicit `tenant_id` parameter.
- D-03: Scoped client is created per-request (lightweight — Extensions wrap, don't clone the connection pool). No caching of extended clients.
- D-04: All service method signatures change from `tenantId: string = DEFAULT_TENANT_ID` to `tenantId: string` (required, no default). Affected: ~8 service files, ~12 API routes, 2 Lambda functions.
- D-05: API routes source tenantId from `getSessionTenantId()`. Lambda functions source tenantId from the schedule/resource record itself.
- D-06: The `DEFAULT_TENANT_ID` constant and all imports of it are deleted from the codebase entirely. No env var, no fallback.
- D-07: Scheduler Lambda iterates all active tenants by querying the `Tenant` table for `status = 'active'`, then fetches and processes schedules per tenant.
- D-08: Add a minimal `status` enum column (`active` | `suspended`) to the Tenant Prisma model in this phase.
- D-09: Scheduler processes tenants sequentially (not parallel).
- D-10: Discovery Lambda includes `tenant_id` in all DynamoDB inventory writes and as an SQS message attribute.
- D-11: Discovery Lambda sources `tenant_id` from the AWS account record it's scanning.
- D-12: Thread IDs restructured to namespaced format `tenantId:userId:uuid`. New threads use this format; existing threads need a one-time migration script.
- D-13: Thread load in chat route and thread list API validates that the embedded `tenantId` matches the session's tenantId. Mismatch returns 403.
- D-14: Tenant-scoped wrapper around `PostgresSaver` and `getChatHistory()` — always validates/prepends tenantId before any checkpoint or history operation.
- D-15: Fix `PostgresChatHistory` in persistence.ts which currently conflates `userId` with `tenantId`.
- D-16: Integration test creates two tenants (A and B), seeds data for both, then verifies cross-tenant access is impossible across all modules.

### Claude's Discretion
- Exact Prisma Client Extension implementation details (query vs allOperations hook)
- Migration script approach for existing thread IDs (batch vs lazy migration)
- Test fixture setup for two-tenant isolation test
- Error message wording for tenant mismatch 403 responses
- Whether to add tenant_id index on any tables that don't have it yet

### Deferred Ideas (OUT OF SCOPE)
- Full suspension enforcement (read-only vs locked modes, session invalidation) — Phase 15
- Parallel tenant processing in scheduler Lambda — future optimization
- PostgreSQL Row-Level Security (RLS) as additional defense layer — future hardening
- Thread ID migration for existing data — can be lazy (migrate on access) or batch script
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ISOL-01 | Scoped Prisma client factory (`getTenantClient(tenantId)`) using Prisma Client Extensions enforces `tenant_id` on every query | Prisma `$extends` query hook intercepts all model operations; per-request factory is lightweight |
| ISOL-02 | All `DEFAULT_TENANT_ID` fallbacks removed from service layer; missing tenant_id is a hard error | `getSessionTenantId()` already throws — natural replacement; ~8 service files + ~12 API routes identified |
| ISOL-03 | Scheduler Lambda includes `tenant_id` filter in all queries and skips schedules for suspended tenants | `pg-service.ts` already scopes by tenantId; need tenant iteration loop + Tenant.status column |
| ISOL-04 | Discovery Lambda includes `tenant_id` in all inventory writes and SQS message attributes | `data_processor.py` already has tenant_id param defaulting to 'default'; needs account→tenant mapping |
| ISOL-05 | LangGraph thread IDs namespaced as `tenantId:userId:uuid`; thread load validates embedded tenantId matches session | `chat/route.ts` line 49 assigns bare threadId; `threads/route.ts` scans without tenant filter |
| ISOL-06 | Two-tenant isolation test verifies Tenant A cannot read/write Tenant B's data across all modules | Vitest integration test with real DB; all models have tenantId index for efficient scoped queries |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@prisma/client` | 6.x (project) | ORM + Client Extensions | `$extends` is the official Prisma isolation pattern |
| `pg` | project dep | Raw pool in scheduler Lambda | Already in use; Prisma too heavy for Lambda |
| Vitest | ^4.0.18 | Integration tests | Project standard (web-ui) |

### Prisma Client Extensions — `$extends` query hook

The `query` component of `$extends` intercepts every Prisma model operation before it hits the database. It receives `{ model, operation, args, query }` and can mutate `args` before calling `query(args)`.

**Installation:** No new packages needed — `$extends` is built into `@prisma/client`.

## Architecture Patterns

### Pattern 1: Scoped Client Factory via Prisma Extensions

```typescript
// web-ui/lib/db/pg-config.ts — add alongside getPrismaClient()
import { Prisma } from '@prisma/client';

// Models that have tenantId (all business models — NOT auth_* tables)
const TENANT_SCOPED_MODELS = new Set([
    'Account', 'Schedule', 'ScheduleExecution', 'TargetedResource',
    'AuditLog', 'KnowledgeBase', 'DataSource', 'InventoryResource',
    'AgentOpsRun', 'AgentOpsEvent', 'ScheduledTask', 'AgentMemory',
    'ChatMessage', 'CustomRole', 'UserTenantRole', 'TenantConfig',
]);

export function getTenantClient(tenantId: string) {
    if (!tenantId) throw new Error('getTenantClient: tenantId is required');
    const base = getPrismaClient();
    return base.$extends({
        query: {
            $allModels: {
                async $allOperations({ model, operation, args, query }) {
                    if (!TENANT_SCOPED_MODELS.has(model ?? '')) {
                        return query(args);
                    }
                    // Inject tenantId into WHERE for reads
                    if (['findMany', 'findFirst', 'findUnique', 'count', 'aggregate'].includes(operation)) {
                        args.where = { ...args.where, tenantId };
                    }
                    // Inject tenantId into data for writes
                    if (['create', 'upsert'].includes(operation)) {
                        args.data = { ...args.data, tenantId };
                    }
                    if (operation === 'update' || operation === 'updateMany') {
                        args.where = { ...args.where, tenantId };
                    }
                    if (operation === 'delete' || operation === 'deleteMany') {
                        args.where = { ...args.where, tenantId };
                    }
                    return query(args);
                },
            },
        },
    });
}
```

**Key facts (HIGH confidence — Prisma docs):**
- `$extends` returns a new client object; it does NOT clone the connection pool. The underlying pool is shared.
- The extended client is a plain object — safe to create per-request with no performance penalty.
- `$allModels.$allOperations` is the correct hook for blanket interception. Per-model hooks (`query.account.findMany`) are also valid but require listing each model.
- `findUnique` and `findUniqueOrThrow` also pass through the query hook — tenantId injection works there too.
- Raw queries (`$executeRaw`, `$queryRaw`, `$queryRawUnsafe`) bypass Extensions entirely — must be manually scoped.

### Pattern 2: DEFAULT_TENANT_ID Removal

**Before:**
```typescript
static async getAccount(accountId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<UIAccount | null>
```

**After:**
```typescript
static async getAccount(accountId: string, tenantId: string): Promise<UIAccount | null>
```

**API route pattern (already established):**
```typescript
export async function GET(req: NextRequest) {
    const authError = authorize('read', 'Account');
    if (authError) return authError;
    const tenantId = await getSessionTenantId(); // throws → 401 if missing
    return NextResponse.json(await AccountService.getAccounts({ tenantId }));
}
```

### Pattern 3: Scheduler Tenant Iteration

**Before (broken):**
```typescript
const pgSchedules = await getSchedulesPg(DEFAULT_TENANT_ID); // single hardcoded tenant
```

**After:**
```typescript
// In scheduler-service.ts runFullScan()
const tenants = await getActiveTenants(); // new pg-service function
for (const tenant of tenants) {
    const schedules = await getSchedulesPg(tenant.tenantId);
    const accounts = await getAccountsPg(tenant.tenantId);
    // process schedules...
}
```

**New `pg-service.ts` function needed:**
```typescript
export async function getActiveTenants(): Promise<Array<{ id: string; name: string }>> {
    const result = await client.query(
        `SELECT id, name FROM tenants WHERE status = 'active' ORDER BY "createdAt" ASC`
    );
    return result.rows;
}
```

### Pattern 4: LangGraph Thread ID Namespacing

**New thread ID format:** `${tenantId}:${userId}:${uuid}`

**Thread access validation in `chat/route.ts`:**
```typescript
// After resolving threadId from request
if (requestThreadId && requestThreadId.includes(':')) {
    const [embeddedTenantId] = requestThreadId.split(':');
    const sessionTenantId = await getSessionTenantId();
    if (embeddedTenantId !== sessionTenantId) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    }
}
```

**New thread creation:**
```typescript
const threadId = requestThreadId || `${tenantId}:${resolvedUserId}:${Date.now()}`;
```

### Pattern 5: PostgresChatHistory Bug Fix

**Current bug in `persistence.ts` line 66:**
```typescript
// BUG: stores userId in tenantId column
tenantId: userId,
```

**Fix:**
```typescript
// Pass tenantId explicitly through the interface
async addMessages(tenantId: string, userId: string, threadId: string, messages: ...) {
    await prisma.chatMessage.createMany({
        data: messages.map((m) => ({
            tenantId: tenantId,  // correct
            sessionId: threadId,
            ...
        })),
    });
}
```

The `ChatHistoryInterface` signature must be updated to accept `tenantId` as a first parameter, and all callers updated accordingly.

### Pattern 6: Tenant Status Schema Migration

Add to `prisma/schema.prisma` Tenant model:
```prisma
model Tenant {
  id        String   @id @default(cuid())
  name      String
  status    String   @default("active") // active|suspended — CHECK in migration SQL
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  configs TenantConfig[]

  @@index([status])
  @@map("tenants")
}
```

Migration SQL adds CHECK constraint:
```sql
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended'));
CREATE INDEX IF NOT EXISTS tenants_status_idx ON tenants(status);
```

### Anti-Patterns to Avoid

- **Caching the extended client:** Don't store `getTenantClient(tenantId)` in a module-level variable — it would leak one tenant's scope to another request.
- **Using `getPrismaClient()` directly in service layer after this phase:** All service-layer DB access must go through `getTenantClient(tenantId)`. Direct `getPrismaClient()` calls are only valid in `pg-config.ts` itself and in the scoped client factory.
- **Trusting thread IDs from the client without validation:** The thread ID format `tenantId:userId:uuid` is a hint, not a guarantee. Always validate the embedded tenantId against the session.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-query tenant injection | Manual WHERE clauses in every repo method | Prisma `$extends` query hook | Extensions intercept at ORM level — impossible to forget |
| Thread ownership validation | Custom JWT or signed thread IDs | Embedded tenantId + session comparison | Simple, stateless, no extra crypto |
| Tenant list for scheduler | Custom DynamoDB scan | `SELECT id FROM tenants WHERE status='active'` | Already have Tenant table in PostgreSQL |

## Common Pitfalls

### Pitfall 1: `$allOperations` vs per-operation hooks
**What goes wrong:** Using `findMany` hook only — `findFirst`, `findUnique`, `count` bypass the filter.
**Why it happens:** Developers list only the operations they think are used.
**How to avoid:** Use `$allOperations` to catch everything. The TENANT_SCOPED_MODELS set gates which models get filtered.
**Warning signs:** Tests pass for `findMany` but `findFirst` returns cross-tenant data.

### Pitfall 2: `create` with nested `connect` bypasses tenantId injection
**What goes wrong:** `prisma.schedule.create({ data: { ..., account: { connect: { id } } } })` — the `connect` doesn't get tenantId injected on the nested model.
**Why it happens:** Extensions inject into the top-level `data`, not nested relations.
**How to avoid:** Nested `connect` operations don't write a new row — they reference an existing one. The existing row already has tenantId. This is safe. Only `create` within a nested write would be a concern, and the codebase doesn't use nested creates.

### Pitfall 3: PostgresChatHistory userId/tenantId conflation breaks after scoped client
**What goes wrong:** After the scoped client enforces tenantId, chat history queries with `tenantId: userId` will return no results (or wrong results) because the stored tenantId is actually a userId string.
**Why it happens:** The original implementation passed `userId` as the first arg to `addMessages`, which stored it in the `tenantId` column.
**How to avoid:** Fix D-15 (PostgresChatHistory) BEFORE enabling the scoped client for ChatMessage queries. The fix must be in the same plan as the scoped client, or chat history breaks immediately.

### Pitfall 4: Scheduler Lambda `runPartialScan` still uses DynamoDB path
**What goes wrong:** `runPartialScan` calls `fetchScheduleById(scheduleId, event.tenantId)` which goes to DynamoDB, not PostgreSQL. The tenant iteration loop only applies to `runFullScan`.
**Why it happens:** The partial scan path has its own fetch logic.
**How to avoid:** Ensure `runPartialScan` also validates `event.tenantId` is present and non-empty before proceeding. The DynamoDB path already accepts tenantId — just ensure it's not DEFAULT_TENANT_ID.

### Pitfall 5: `threads/route.ts` GET scans all users' threads
**What goes wrong:** The current GET handler does a full DynamoDB scan with no tenant filter. After migration to PostgreSQL thread storage, this would expose all tenants' threads.
**Why it happens:** The original implementation was single-tenant.
**How to avoid:** Add `WHERE "tenantId" = $1` to the thread list query. For the DynamoDB path (still active), filter by `ownerUserId` matching the session user — this is a partial fix until full PostgreSQL migration.

### Pitfall 6: Raw SQL in `persistence.ts` agent memories uses userId as tenantId
**What goes wrong:** The `$executeRaw` upsert in `PostgresMemoryStore.batch()` uses `userId` for both `tenantId` and `userId` columns (lines 132-133). After scoped client enforcement, vector search queries will also use userId as tenantId.
**Why it happens:** Same conflation pattern as PostgresChatHistory.
**How to avoid:** The raw SQL must be updated to accept a real `tenantId` parameter. The `saveMemory` / `searchMemory` public API must be updated to accept tenantId.

## Code Examples

### Two-Tenant Isolation Test Structure
```typescript
// web-ui/tests/isolation/two-tenant-isolation.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTenantClient } from '@/lib/db/pg-config';
import { getPrismaClient } from '@/lib/db/pg-config';

describe('Two-Tenant Isolation', () => {
    const tenantA = 'test-tenant-a';
    const tenantB = 'test-tenant-b';
    let clientA: ReturnType<typeof getTenantClient>;
    let clientB: ReturnType<typeof getTenantClient>;

    beforeAll(async () => {
        // Seed tenants and data
        const prisma = getPrismaClient();
        await prisma.tenant.createMany({ data: [{ id: tenantA, name: 'Tenant A' }, { id: tenantB, name: 'Tenant B' }], skipDuplicates: true });
        await prisma.account.create({ data: { tenantId: tenantA, accountId: 'acc-a', name: 'Account A', roleArn: 'arn:aws:iam::111:role/r', regions: [] } });
        await prisma.account.create({ data: { tenantId: tenantB, accountId: 'acc-b', name: 'Account B', roleArn: 'arn:aws:iam::222:role/r', regions: [] } });
        clientA = getTenantClient(tenantA);
        clientB = getTenantClient(tenantB);
    });

    it('Tenant A cannot read Tenant B accounts', async () => {
        const accounts = await clientA.account.findMany();
        expect(accounts.every(a => a.tenantId === tenantA)).toBe(true);
        expect(accounts.find(a => a.accountId === 'acc-b')).toBeUndefined();
    });

    it('Tenant B cannot read Tenant A accounts', async () => {
        const accounts = await clientB.account.findMany();
        expect(accounts.every(a => a.tenantId === tenantB)).toBe(true);
    });

    // ... repeat for Schedule, AuditLog, ChatMessage, AgentMemory
});
```

### Discovery Lambda tenant_id injection
```python
# data_processor.py — get tenant_id from account record at scan start
def get_tenant_id_for_account(account_id: str, dynamodb_client) -> str:
    """Look up the tenant that owns this AWS account."""
    response = dynamodb_client.get_item(
        TableName=os.environ['APP_TABLE_NAME'],
        Key={'pk': {'S': f'ACCOUNT#{account_id}'}, 'sk': {'S': 'METADATA'}}
    )
    item = response.get('Item', {})
    return item.get('tenantId', {}).get('S', 'default')
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| DEFAULT_TENANT_ID fallback | Hard error on missing tenantId | Phase 14 | Prevents silent single-tenant operation |
| Bare UUID thread IDs | `tenantId:userId:uuid` namespaced | Phase 14 | Thread ownership verifiable without DB lookup |
| userId stored as tenantId in ChatMessage | Actual tenantId stored | Phase 14 | Chat history correctly scoped per tenant |

## Open Questions

1. **Discovery Lambda account→tenant mapping source**
   - What we know: `data_processor.py` has `tenant_id` param defaulting to `'default'`; accounts are stored in DynamoDB with `tenantId` field
   - What's unclear: Whether the discovery Lambda invocation event carries tenantId, or whether it must look it up from the account record
   - Recommendation: Read tenantId from the DynamoDB account record at scan start (D-11). The account record already has `tenantId` field from the existing schema.

2. **Existing thread ID migration**
   - What we know: Existing threads in DynamoDB/PostgreSQL use bare UUIDs or `Date.now()` strings
   - What's unclear: Volume of existing threads; whether lazy migration (validate on access, migrate if old format) is safe
   - Recommendation: Lazy migration — on thread load, if threadId doesn't contain `:`, treat as legacy and allow access for the session user only (no tenantId validation). Log for monitoring. Deferred per CONTEXT.md.

3. **`InventoryVectorKey` and `InventorySyncStatus` models have no tenantId**
   - What we know: These two models in schema.prisma lack `tenantId` columns
   - What's unclear: Whether they need tenant scoping (InventoryVectorKey is keyed by accountId; InventorySyncStatus is a global scan tracker)
   - Recommendation: Exclude from TENANT_SCOPED_MODELS set. InventoryVectorKey is scoped by accountId (accounts are already tenant-scoped). InventorySyncStatus is a global operational table.

## Environment Availability

Step 2.6: SKIPPED — Phase 14 is code/config changes only. No new external dependencies. PostgreSQL and the scheduler Lambda are already operational from prior phases.

## Validation Architecture

`nyquist_validation` is explicitly `false` in `.planning/config.json` — this section is skipped.

## Sources

### Primary (HIGH confidence)
- Prisma Client Extensions docs — `$extends` query hook, `$allModels.$allOperations` pattern
- `/Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy/prisma/schema.prisma` — all model definitions, tenantId columns confirmed
- `/Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy/web-ui/lib/db/pg-config.ts` — existing PrismaClient singleton
- `/Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy/web-ui/lib/auth-session.ts` — `getSessionTenantId()` throws on missing tenantId
- `/Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy/web-ui/lib/agent/persistence.ts` — PostgresChatHistory userId/tenantId bug confirmed (line 66)
- `/Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy/lambda/scheduler/src/services/scheduler-service.ts` — DEFAULT_TENANT_ID usage on lines 24, 36 confirmed
- `/Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy/lambda/scheduler/src/services/pg-service.ts` — already scopes by tenantId param; DEFAULT_TENANT_ID default on function signatures
- `/Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy/web-ui/app/api/chat/route.ts` — bare threadId assignment, no tenantId validation
- `/Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy/web-ui/app/api/threads/route.ts` — full scan without tenant filter

### Secondary (MEDIUM confidence)
- Grep audit of DEFAULT_TENANT_ID across web-ui/lib — 8 service files, 4 repository files confirmed

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — Prisma Extensions are stable API, project stack is well-understood
- Architecture: HIGH — all patterns derived from reading actual source files
- Pitfalls: HIGH — bugs identified from direct code inspection (not speculation)

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (stable libraries, 30-day window)

# Pitfalls Research: Multi-Tenancy on Existing Next.js + Prisma + NextAuth

**Domain:** Adding multi-tenancy, custom RBAC, dual auth, user invitations, tenant suspension, and admin panel to an existing single-tenant Next.js + Prisma + NextAuth application
**Researched:** 2026-03-31
**Confidence:** HIGH (core patterns well-established; specific NextAuth/Prisma integration details verified against known behavior)

---

## Critical Pitfalls

### Pitfall 1: Tenant Data Leak via Missing tenant_id in Prisma Queries

**What goes wrong:**
A developer adds a new query or forgets to include `WHERE tenant_id = $1` on an existing one. The query returns data from all tenants. Because the app appears to work correctly for the logged-in user (their data is in the result set), the leak goes undetected until a security audit or incident.

**Why it happens:**
Prisma has no built-in row-level security enforcement. The `tenant_id` column exists on tables but nothing in the ORM prevents a query without it. In a large codebase with many service files, it's easy to miss one. The existing codebase already has this risk — `tenant_id` exists from v1.0 but enforcement was described as "may be inconsistent."

**How to avoid:**
- Wrap every Prisma client in a tenant-scoped factory: `getTenantClient(tenantId)` returns a Prisma extension that automatically appends `WHERE tenant_id = tenantId` to every `findMany`, `findFirst`, `findUnique`, `update`, `delete`, and `count` call via Prisma Client Extensions (`$extends`).
- Never expose the raw `prisma` client to service layer code — only the scoped client.
- Add a lint rule or custom ESLint plugin that flags direct `prisma.*` calls outside the factory module.
- Write a test that creates two tenants with overlapping data and asserts that querying as tenant A never returns tenant B's records.

**Warning signs:**
- Service functions that accept `tenantId` as a parameter but don't pass it to Prisma queries.
- Any `prisma.findMany()` call without a `where: { tenantId }` clause.
- API routes that read `tenantId` from the request body (user-controlled) rather than from the session.

**Phase to address:** Foundation phase — tenant isolation must be the first thing built, before any feature work. Every subsequent phase inherits this guarantee.

---

### Pitfall 2: Reading tenant_id from Request Body Instead of Session

**What goes wrong:**
An API route accepts `tenantId` as a POST body parameter or query string. A malicious user sends a different `tenantId` and reads or modifies another tenant's data. This is a horizontal privilege escalation — the user is authenticated but accesses resources they don't own.

**Why it happens:**
It's convenient during development to pass `tenantId` explicitly. The developer assumes the frontend will always send the correct value. This assumption breaks the moment someone uses curl or a browser devtools override.

**How to avoid:**
- `tenantId` must always come from `getServerSession()` — never from request parameters.
- Pattern: `const { tenantId } = await getServerSession(authOptions)` at the top of every API route, before any data access.
- Add a middleware layer (`withTenantSession`) that extracts and validates `tenantId` from the session and injects it into the request context.
- In the Prisma scoped client factory, the `tenantId` is sealed at construction time from the session — it cannot be overridden by caller code.

**Warning signs:**
- `req.body.tenantId`, `searchParams.get('tenantId')`, or `params.tenantId` used in data queries.
- API routes that don't call `getServerSession()` before accessing data.

**Phase to address:** Foundation phase — establish the session-extraction pattern before any API routes are written or modified.

---

### Pitfall 3: CASL Removal Leaves an Unguarded Window

**What goes wrong:**
CASL is removed from all routes before the new custom RBAC system is fully implemented and tested. During the gap, API routes have no authorization checks — any authenticated user can perform any action on any tenant's data.

**Why it happens:**
The natural instinct is to rip out the old system first, then build the new one. But in a production app, this creates a window of zero authorization enforcement.

**How to avoid:**
- Build and test the new RBAC system completely before removing a single CASL import.
- Use a feature flag: `USE_NEW_RBAC=true` routes through the new system; `false` falls back to CASL. Flip the flag per-route as each is migrated.
- The cutover sequence per route: (1) add new RBAC check alongside CASL, (2) verify both agree in staging, (3) remove CASL check.
- Never delete `@casl/ability` from `package.json` until every route has been migrated and verified.

**Warning signs:**
- Any API route that has `// TODO: add RBAC` comments.
- Routes where the old `authorize()` call was deleted but no new permission check was added.
- Integration tests that pass because they're running as a super admin (which bypasses all checks).

**Phase to address:** RBAC phase — the migration plan must be explicit about the parallel-run period.

---

### Pitfall 4: New RBAC System Has No Default-Deny Baseline

**What goes wrong:**
The custom RBAC system is built with an explicit allow-list but no default-deny. A new route is added without a permission check. Because there's no catch-all denial, the route is accessible to any authenticated user.

**Why it happens:**
Developers focus on "what should be allowed" and forget to enforce "everything else is denied." This is especially common when the RBAC check is opt-in (called explicitly per route) rather than opt-out (enforced by middleware with explicit bypass).

**How to avoid:**
- The RBAC middleware must be applied globally (Next.js middleware or a route wrapper) with an explicit allowlist of public routes.
- Pattern: every route is protected by default; routes opt out by being listed in `PUBLIC_ROUTES`.
- The `authorize()` function must throw/return 403 if no matching permission rule is found — never silently allow.
- Add a test: create a new route without any RBAC annotation and assert it returns 403 for a non-admin user.

**Warning signs:**
- `authorize()` function that returns `true` when no rule matches (instead of `false`).
- RBAC checks that are copy-pasted per route rather than enforced by middleware.
- New routes added during feature development that don't appear in any RBAC rule set.

**Phase to address:** RBAC phase — the default-deny baseline must be the first thing implemented in the RBAC system.

---

### Pitfall 5: Dual Auth Providers Produce Inconsistent Session Shapes

**What goes wrong:**
NextAuth with Cognito provider produces a session where `session.user.id` is the Cognito `sub` (a UUID). NextAuth with Credentials provider produces a session where `session.user.id` is whatever the `authorize()` callback returns. If these shapes differ, code that reads `session.user.id` works for one provider and breaks for the other — or worse, silently uses the wrong value.

**Why it happens:**
NextAuth's session object is shaped by the provider's profile callback and the `session` callback in `authOptions`. When adding a second provider, developers often forget to normalize the session shape in the `session` callback.

**How to avoid:**
- Define a canonical session type: `{ user: { id: string, tenantId: string, role: string, email: string } }`.
- In the NextAuth `session` callback, explicitly map both providers' outputs to this canonical shape.
- In the `jwt` callback, normalize the token regardless of which provider authenticated the user.
- Write a test for each provider that asserts the session shape matches the canonical type.
- Use TypeScript module augmentation to override NextAuth's `Session` type — this catches shape mismatches at compile time.

**Warning signs:**
- `session.user.id` returning `undefined` for one provider.
- Code that checks `if (session.user.provider === 'cognito')` to branch behavior — this is a smell that the session isn't normalized.
- `session.user.sub` used in some places and `session.user.id` in others.

**Phase to address:** Auth foundation phase — normalize session shape before any feature code reads from the session.

---

### Pitfall 6: Cognito and Credentials Providers Share a User Table with Conflicting Identity

**What goes wrong:**
A user signs up via Credentials (email + password stored in PostgreSQL). Later, the same email is used to sign in via Cognito. NextAuth's Prisma adapter creates a second `User` record (or links to the wrong account), resulting in two separate identities for the same person — with different `tenantId` associations, different roles, and split data.

**Why it happens:**
NextAuth's account linking logic depends on the `email` field being unique and the adapter correctly matching existing users. With the Prisma adapter, if the `Account` table doesn't have a record for the Cognito provider for that user, a new user is created.

**How to avoid:**
- Enable `allowDangerousEmailAccountLinking: true` in NextAuth config only if you've verified the email is confirmed by both providers (Cognito verifies email; Credentials must also verify before allowing login).
- Alternatively, enforce a single auth path per user: if a user was created via Credentials, they cannot log in via Cognito with the same email (and vice versa) — return an error with a clear message.
- Add a unique constraint on `User.email` in the Prisma schema.
- In the `signIn` callback, check if the email already exists with a different provider and handle explicitly.

**Warning signs:**
- Duplicate `User` records with the same email in the database.
- Users reporting lost data after switching login methods.
- `tenantId` being `null` on users created via one provider but not the other.

**Phase to address:** Auth foundation phase — account linking strategy must be decided and implemented before both providers go live.

---

### Pitfall 7: Invitation Tokens Are Guessable or Reusable

**What goes wrong:**
Invitation tokens are generated with `Math.random()` or a short UUID, making them brute-forceable. Or tokens don't expire. Or a token can be used multiple times (no single-use enforcement). An attacker enumerates tokens and joins a tenant they weren't invited to.

**Why it happens:**
Invitation flows are often built quickly. Developers use whatever random generation is handy and forget to add expiry and single-use enforcement.

**How to avoid:**
- Generate tokens with `crypto.randomBytes(32).toString('hex')` — 256 bits of entropy, not guessable.
- Store a hashed version of the token in the database (`sha256(token)`) — never the raw token.
- Set a 48-hour expiry on all invitation tokens.
- Mark tokens as `used: true` immediately on acceptance — check this flag before processing any invitation.
- Rate-limit the invitation acceptance endpoint (5 attempts per IP per hour).
- Scope tokens to a specific email address — reject if the accepting user's email doesn't match.

**Warning signs:**
- `Math.random()` or `uuid()` (v4 is fine for IDs but not for security tokens) used for invitation tokens.
- No `expiresAt` column on the `Invitation` table.
- No `usedAt` or `status` column to track single-use enforcement.
- Invitation acceptance endpoint not rate-limited.

**Phase to address:** User invitations phase — security requirements must be in the acceptance criteria, not added as an afterthought.

---

### Pitfall 8: Tenant Suspension Not Enforced at the Session Layer

**What goes wrong:**
A tenant is suspended in the database (`status: 'suspended'`). But existing sessions for users of that tenant remain valid — they can continue using the app until their session expires (potentially 30 days). The suspension has no immediate effect.

**Why it happens:**
NextAuth sessions are stateless JWTs (or database sessions that are only checked at login). Suspension status is checked at login time but not on every request.

**How to avoid:**
- Use database sessions (not JWT sessions) so you can invalidate them server-side. With the Prisma adapter, set `session: { strategy: 'database' }` in NextAuth config.
- Add a middleware check on every request: look up the tenant's `status` from a fast cache (Redis or in-memory with a 60-second TTL) and return 403 if suspended.
- Alternatively, on suspension, delete all active sessions for that tenant's users from the `Session` table directly.
- The suspension check must happen in Next.js middleware (runs on every request) not just in API routes.

**Warning signs:**
- `session: { strategy: 'jwt' }` in NextAuth config — JWTs cannot be revoked without a denylist.
- Suspension only checked in the login flow, not on authenticated requests.
- No mechanism to force-logout all users of a suspended tenant.

**Phase to address:** Tenant lifecycle phase — suspension must be designed with session invalidation in mind from the start.

---

### Pitfall 9: Super Admin Panel Accessible to Tenant Admins

**What goes wrong:**
The `/admin` route is protected by a check like `if (user.role === 'admin')`. A tenant-level admin (who has `role: 'admin'` within their tenant) passes this check and gains access to the super admin panel — seeing all tenants, being able to suspend other orgs, etc.

**Why it happens:**
The role system conflates "admin within a tenant" with "platform-level super admin." Both use the string `'admin'` but mean completely different things.

**How to avoid:**
- Use a separate `isSuperAdmin: boolean` flag on the `User` model (or a dedicated `role: 'super_admin'` that is never assignable within a tenant context).
- Super admin is a platform-level concept — it must be set directly in the database, never through any tenant-facing UI or API.
- The `/admin` route middleware must check `isSuperAdmin === true`, not `role === 'admin'`.
- Super admin users must not have a `tenantId` — they are platform-level only. Any query that joins on `tenantId` must exclude super admins.
- Add a test: create a tenant admin, attempt to access `/admin`, assert 403.

**Warning signs:**
- `role === 'admin'` used as the super admin check anywhere in the codebase.
- Super admin creation available through any API endpoint (must be database-only or a protected CLI script).
- `/admin` routes that don't verify `isSuperAdmin` before every data access.

**Phase to address:** Super admin phase — the role separation must be in the data model before any admin UI is built.

---

### Pitfall 10: Lambda Functions Contaminate Cross-Tenant Data

**What goes wrong:**
The scheduler Lambda processes schedules for all tenants in a single invocation. It reads a schedule, assumes a cross-account IAM role, and executes the action. If the Lambda doesn't scope its DynamoDB/PostgreSQL queries by `tenantId`, it may process schedules from tenant A using context loaded for tenant B — or worse, write results back to the wrong tenant's records.

**Why it happens:**
Lambda functions were written for a single-tenant world. `tenantId` was added to the schema but the Lambda code was never updated to filter by it. The Lambda runs with a single IAM role that has access to all tenants' data.

**How to avoid:**
- Every Lambda that reads from PostgreSQL must include `WHERE tenant_id = $1` — use the same scoped Prisma client pattern as the web app.
- For the scheduler Lambda: process schedules grouped by `tenantId`; load tenant config once per tenant group, not once per invocation.
- For the discovery Lambda (Python): add `tenant_id` filter to all psycopg2 queries.
- Add a `tenantId` field to all Lambda event payloads (SQS messages, EventBridge events) so the Lambda knows which tenant context it's operating in.
- Write an integration test that creates schedules for two tenants and asserts the Lambda only processes each schedule in its correct tenant context.

**Warning signs:**
- Lambda handler that calls `prisma.schedule.findMany()` without `where: { tenantId }`.
- SQS message payloads that don't include `tenantId`.
- Lambda that loads "global" config at cold start without tenant scoping.

**Phase to address:** Lambda tenant awareness phase — must be addressed before any tenant goes live with scheduled operations.

---

### Pitfall 11: LangGraph Agent Sessions Leak Across Tenants

**What goes wrong:**
LangGraph uses a thread ID for checkpointing agent state. If thread IDs are not namespaced by `tenantId`, a user from tenant A could (accidentally or maliciously) pass a thread ID that belongs to tenant B and read that tenant's agent conversation history, tool call results, or AWS resource data.

**Why it happens:**
Thread IDs are often generated client-side or passed as URL parameters. The checkpointer stores and retrieves state by thread ID alone, with no tenant validation.

**How to avoid:**
- Namespace all thread IDs: `threadId = ${tenantId}:${userId}:${uuid}` — never accept a bare UUID as a thread ID.
- Before loading any checkpoint, verify that the thread ID's embedded `tenantId` matches the session's `tenantId`.
- The DynamoDB/PostgreSQL checkpointer table must have `tenantId` as a partition key component, not just `threadId`.
- Memory store (long-term agent memory) must also be scoped: queries to the memory store must include `tenantId` in the filter.

**Warning signs:**
- Thread IDs that are plain UUIDs with no tenant prefix.
- Checkpoint retrieval that doesn't validate tenant ownership before returning state.
- Agent memory queries without `tenantId` filter.

**Phase to address:** AI agent tenant scoping phase — must be addressed before multi-tenant users can access the AI agent.

---

### Pitfall 12: Org Switcher Doesn't Invalidate Cached Data

**What goes wrong:**
A user switches from tenant A to tenant B using the org switcher. The UI updates the active tenant in the session, but React Query / SWR caches still hold tenant A's data. The user sees tenant A's accounts, schedules, and inventory under tenant B's context — until the cache expires or the page is refreshed.

**Why it happens:**
Client-side data fetching libraries cache by query key. If the query key doesn't include `tenantId`, switching tenants doesn't invalidate the cache.

**How to avoid:**
- Include `tenantId` in every React Query / SWR cache key: `['accounts', tenantId]` not `['accounts']`.
- On tenant switch, call `queryClient.invalidateQueries()` (React Query) or `mutate()` (SWR) to clear all cached data.
- The session update that changes `activeTenantId` must trigger a full cache invalidation before the UI re-renders with new tenant context.
- Consider a brief loading state during tenant switch to prevent stale data flash.

**Warning signs:**
- Query keys that don't include `tenantId` or `activeTenantId`.
- No cache invalidation logic in the tenant switcher component.
- Users reporting seeing "wrong" data after switching orgs.

**Phase to address:** Org switcher phase — cache invalidation must be part of the switcher implementation, not a follow-up fix.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Raw `prisma` client in service layer (no tenant scoping wrapper) | Faster to write | Every query is a potential data leak; requires audit of entire codebase | Never — build the wrapper first |
| JWT sessions instead of database sessions | No DB lookup per request | Cannot revoke sessions on suspension; suspended tenants stay active | Never for a multi-tenant SaaS |
| Checking `role === 'admin'` for super admin | Simple | Tenant admins gain platform access | Never — use a separate `isSuperAdmin` flag |
| Storing raw invitation tokens in DB | Simpler queries | Token theft from DB = account takeover | Never — always store hashed |
| Thread IDs without tenant namespace | Simpler client code | Cross-tenant agent session access | Never — namespace from day one |
| Skipping tenant_id on Lambda SQS payloads | Less message overhead | Lambda processes wrong tenant's data | Never — always include tenantId in events |
| CASL removed before new RBAC is complete | Clean codebase | Zero authorization enforcement window | Never — parallel run required |
| Checking suspension only at login | Simpler implementation | Suspended tenants stay active for session lifetime | Only acceptable if session TTL is <5 minutes |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| NextAuth Prisma adapter | Assuming adapter auto-links accounts by email | Explicitly handle account linking in `signIn` callback; test both providers |
| NextAuth + Cognito | Using Cognito `sub` as user ID without storing it in User table | Store `sub` in `Account` table via Prisma adapter; use internal `User.id` everywhere |
| NextAuth session callbacks | Forgetting to add `tenantId` to the JWT/session in the `jwt` and `session` callbacks | Explicitly map `token.tenantId` → `session.user.tenantId` in both callbacks |
| Prisma Client Extensions | Extension not applied to all query types (e.g., `$queryRaw` bypasses extensions) | Audit all raw SQL calls; apply tenant filter manually to `$queryRaw` and `$executeRaw` |
| LangGraph DynamoDB checkpointer | Thread IDs stored without tenant prefix | Migrate existing threads to namespaced IDs before multi-tenant launch |
| Cognito user pool | Cognito user attributes don't include `tenantId` | Store tenant association in PostgreSQL `User` table, not in Cognito attributes |
| SQS + Lambda | SQS messages don't carry `tenantId` | Add `tenantId` to message attributes; Lambda reads from attributes, not just body |
| psycopg2 (discovery Lambda) | Connection pool shared across tenant invocations | Use connection-per-invocation or ensure all queries include `tenant_id` filter |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Tenant suspension check hits DB on every request | High DB load, slow response times | Cache suspension status in Redis or in-memory with 60s TTL | At ~100 req/s per tenant |
| No index on `tenant_id` columns | Slow queries as data grows | Add `@@index([tenantId])` to every Prisma model that has `tenantId` | At ~10K rows per table |
| Loading all tenant members to check permissions | N+1 queries in RBAC middleware | Denormalize role into the session JWT; check session, not DB | At ~50 members per tenant |
| React Query cache keys without tenantId | Stale data shown after org switch | Include `tenantId` in all cache keys | Immediately on first org switch |
| LangGraph checkpoint table without tenant partition | Full table scan for thread lookup | Composite key: `(tenantId, threadId)` as primary key | At ~1K threads across tenants |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| `tenantId` from request body | Horizontal privilege escalation — read/write any tenant's data | Always extract `tenantId` from `getServerSession()` |
| Invitation token not scoped to email | Token forwarding attack — anyone with the link can join | Bind token to invitee email; reject if accepting user's email doesn't match |
| Super admin route protected only by `role === 'admin'` | Tenant admin gains platform-level access | Separate `isSuperAdmin` flag; never assignable via tenant UI |
| Raw invitation token stored in DB | DB read = account takeover | Store `sha256(token)`; send raw token in email only |
| JWT sessions with long TTL | Suspended tenant stays active for days | Use database sessions; delete sessions on suspension |
| RBAC permission check missing on new route | Any authenticated user can call the route | Default-deny middleware; explicit allowlist for public routes |
| Agent thread ID accepted from client without validation | Cross-tenant agent session access | Validate thread ID's embedded tenantId matches session tenantId |
| Lambda reads tenantId from event body (user-controlled) | Tenant impersonation in async jobs | Lambda derives tenantId from the resource being processed, not from caller input |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Suspension shows generic 500 error | User confused, thinks app is broken | Show a clear "Your organization has been suspended. Contact support." page |
| Invitation link works after account already created | User tries to re-use link, gets cryptic error | Show "This invitation has already been accepted" with a login link |
| Org switcher reloads entire page | Jarring UX, loses scroll position | Invalidate React Query cache and re-fetch in background; update URL without full reload |
| Tenant settings saved without confirmation | Accidental changes to branding/timezone | Require explicit "Save" action; show diff of what changed |
| Super admin panel looks identical to tenant admin panel | Super admin accidentally thinks they're in a tenant context | Distinct visual treatment (banner, color scheme) for super admin context |
| Permission denied shows no explanation | User doesn't know what they're missing | Show which permission is required; link to contact their org admin |

---

## "Looks Done But Isn't" Checklist

- [ ] **Tenant isolation:** `tenant_id` column exists on all tables — verify every Prisma query actually filters by it (not just the tables, the queries)
- [ ] **Session normalization:** Both Cognito and Credentials providers tested — verify `session.user.tenantId` is populated for both
- [ ] **Suspension enforcement:** Tenant suspended in DB — verify existing sessions are invalidated immediately, not just blocked at next login
- [ ] **RBAC migration:** CASL imports removed — verify no route lost its authorization check during the migration
- [ ] **Invitation security:** Invitation flow works end-to-end — verify token is single-use, expires in 48h, and is scoped to the invitee's email
- [ ] **Super admin isolation:** `/admin` route returns 403 for tenant admins — verify with a test using a tenant-level `role: 'admin'` user
- [ ] **Lambda tenant scoping:** Scheduler Lambda processes schedules — verify it only processes schedules for the correct tenant when multiple tenants have active schedules
- [ ] **Org switcher cache:** Switching orgs shows correct data — verify no stale data from previous tenant appears after switch
- [ ] **Agent session scoping:** LangGraph thread IDs are namespaced — verify a user cannot load another tenant's thread by guessing the ID
- [ ] **Default-deny RBAC:** New route added without permission annotation — verify it returns 403, not 200

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Tenant data leak discovered in production | HIGH | Audit all queries immediately; add tenant_id filters; notify affected tenants; rotate any exposed credentials |
| CASL removed before new RBAC complete | HIGH | Re-add CASL temporarily; treat as a security incident; implement new RBAC under feature flag |
| Invitation tokens not hashed (raw tokens in DB) | MEDIUM | Rotate all pending invitations; re-hash existing tokens; notify users with active invitations |
| Suspended tenant still has active sessions | MEDIUM | Delete all sessions for tenant's users from Session table directly via DB query |
| Duplicate User records from dual auth | MEDIUM | Write a migration script to merge accounts; pick canonical User.id; update all foreign keys |
| Lambda processed wrong tenant's data | HIGH | Audit Lambda execution logs; identify affected records; restore from backup or manual correction |
| Super admin route accessible to tenant admin | HIGH | Immediately restrict route; audit all actions taken via the route; treat as security incident |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Tenant data leak via missing tenant_id | Foundation — Prisma scoped client | Test: two tenants, query as tenant A, assert no tenant B records returned |
| tenantId from request body | Foundation — session extraction pattern | Code review: grep for `req.body.tenantId` and `searchParams.get('tenantId')` |
| CASL removal window | RBAC phase — parallel run strategy | Feature flag test: both old and new RBAC agree on same decisions |
| Default-deny RBAC gap | RBAC phase — middleware baseline | Test: new route without annotation returns 403 |
| Dual auth session shape mismatch | Auth foundation phase | Test: both providers produce identical session shape |
| Cognito + Credentials account collision | Auth foundation phase | Test: same email via both providers handled without duplicate User |
| Invitation token security | User invitations phase | Security checklist: entropy, expiry, single-use, email-scoped |
| Suspension not enforced on active sessions | Tenant lifecycle phase | Test: suspend tenant, verify existing session returns 403 within 60s |
| Super admin accessible to tenant admin | Super admin phase | Test: tenant admin role cannot access /admin |
| Lambda cross-tenant contamination | Lambda tenant awareness phase | Integration test: two tenants' schedules, assert correct tenant isolation |
| LangGraph session leak | AI agent scoping phase | Test: attempt to load another tenant's thread ID, assert 403 |
| Org switcher stale cache | Org switcher phase | Test: switch orgs, assert all data refreshes to new tenant |

---

## Sources

- NextAuth.js documentation — session callbacks, Prisma adapter, account linking behavior (training data, cutoff Aug 2025, HIGH confidence for established patterns)
- Prisma Client Extensions documentation — `$extends` for query middleware (HIGH confidence, well-established feature)
- OWASP multi-tenancy security guidelines — horizontal privilege escalation, tenant isolation patterns (HIGH confidence)
- LangGraph checkpointing documentation — thread ID and state management patterns (MEDIUM confidence — verify current LangGraph version behavior)
- General SaaS multi-tenancy patterns — invitation token security, suspension enforcement, RBAC default-deny (HIGH confidence, industry-standard patterns)
- Next.js middleware documentation — request interception for auth/tenant checks (HIGH confidence)

---
*Pitfalls research for: Multi-tenancy on existing Next.js + Prisma + NextAuth (v3.0 milestone)*
*Researched: 2026-03-31*

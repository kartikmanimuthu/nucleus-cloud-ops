# Architecture Research: Multi-Tenancy Integration

**Domain:** SaaS multi-tenancy on Next.js App Router + Prisma + NextAuth
**Researched:** 2026-03-31
**Confidence:** HIGH (based on direct codebase analysis + verified patterns)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Browser / Client                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  Login Page  │  │ Org Switcher │  │  Feature Pages (scoped)  │  │
│  │  /login      │  │  (header)    │  │  /app/accounts, etc.     │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │
└─────────┼─────────────────┼───────────────────────┼────────────────┘
          │                 │                        │
┌─────────▼─────────────────▼────────────────────────▼────────────────┐
│                    Next.js Middleware (edge)                          │
│  withAuth → tenant context injection → super-admin route guard       │
└─────────────────────────────────────────────────────────────────────┘
          │
┌─────────▼─────────────────────────────────────────────────────────┐
│                    NextAuth (auth-options.ts)                       │
│  Provider 1: CognitoProvider (existing)                            │
│  Provider 2: CredentialsProvider (new — Prisma User lookup)        │
│  JWT callback: embed tenantId, role, isSuperAdmin into token       │
│  Session callback: surface tenantId + role to session.user         │
└─────────────────────────────────────────────────────────────────────┘
          │
┌─────────▼─────────────────────────────────────────────────────────┐
│                    API Route Layer (app/api/)                       │
│  authorize(action, subject, tenantId) — replaces CASL authorize()  │
│  getTenantContext() — extracts tenantId from session               │
│  Super-admin routes: /api/admin/** (platform-level only)           │
└─────────────────────────────────────────────────────────────────────┘
          │
┌─────────▼─────────────────────────────────────────────────────────┐
│                    Service Layer (lib/*-service.ts)                 │
│  All services receive tenantId explicitly — no DEFAULT_TENANT_ID   │
│  Repository calls always include WHERE tenant_id = $tenantId       │
└─────────────────────────────────────────────────────────────────────┘
          │
┌─────────▼─────────────────────────────────────────────────────────┐
│                    Prisma / PostgreSQL                               │
│  New models: User, Invitation, Permission, Role (custom RBAC)      │
│  Existing: tenant_id on all tables (already present from v1.0)     │
│  Tenant.status: active | suspended | pending                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

| Component | Responsibility | Status |
|-----------|---------------|--------|
| `web-ui/middleware.ts` | Auth guard + tenant context injection into request headers | Modify |
| `web-ui/lib/auth-options.ts` | NextAuth config — add CredentialsProvider, extend JWT/session with tenantId + role | Modify |
| `web-ui/lib/auth-session.ts` | `getSessionUserId()` + new `getSessionTenantId()`, `getSessionRole()` | Modify |
| `web-ui/lib/rbac/` | Remove CASL entirely; replace with custom permission check functions | Replace |
| `web-ui/lib/tenant-service.ts` | Tenant CRUD, suspension, onboarding — new service | New |
| `web-ui/lib/user-service.ts` | User persistence for Credentials auth, invitation management | New |
| `web-ui/lib/invitation-service.ts` | Token generation, email dispatch, accept/decline flow | New |
| `web-ui/app/api/admin/**` | Super-admin API routes (tenant management, user management) | New |
| `web-ui/app/app/admin/**` | Super-admin UI pages | Extend existing stub |
| `web-ui/components/org-switcher/` | Tenant dropdown in header, triggers data reload | New |
| `prisma/schema.prisma` | Add User, Invitation, Permission, Role models; add status to Tenant | Modify |
| `lambda/scheduler/` | Read tenantId from schedule record — already present, enforce in queries | Verify |

---

## Integration Points: New vs Modified

### Modified: `web-ui/middleware.ts`

Current middleware only checks `!!token` for auth. Needs two additions:

1. Inject `x-tenant-id` header from `token.tenantId` so API routes can read it without re-fetching the session.
2. Guard `/app/admin/**` and `/api/admin/**` routes — redirect/403 unless `token.isSuperAdmin === true`.

```typescript
// web-ui/middleware.ts (modified)
import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware(req) {
    const token = req.nextauth.token;
    const { pathname } = req.nextUrl;

    // Super-admin guard
    if (pathname.startsWith('/app/admin') || pathname.startsWith('/api/admin')) {
      if (!token?.isSuperAdmin) {
        return pathname.startsWith('/api/')
          ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
          : NextResponse.redirect(new URL('/app/dashboard', req.url));
      }
    }

    // Inject tenant context into request headers for API routes
    const requestHeaders = new Headers(req.headers);
    if (token?.tenantId) {
      requestHeaders.set('x-tenant-id', token.tenantId as string);
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        const { pathname } = req.nextUrl;
        if (pathname === '/login' || pathname === '/' || pathname.startsWith('/docs')) {
          return true;
        }
        return !!token;
      },
    },
  }
);
```

### Modified: `web-ui/lib/auth-options.ts`

Add CredentialsProvider alongside existing CognitoProvider. Extend JWT callback to embed `tenantId`, `role`, `isSuperAdmin`.

```typescript
// Key additions to authOptions
providers: [
  CognitoProvider({ ... }), // existing
  CredentialsProvider({
    name: 'credentials',
    credentials: { email: {}, password: {} },
    async authorize(credentials) {
      // bcrypt compare against User table in Prisma
      const user = await UserService.verifyCredentials(credentials.email, credentials.password);
      if (!user) return null;
      return { id: user.id, email: user.email, name: user.name };
    }
  })
],
callbacks: {
  async jwt({ token, account, user, trigger, session }) {
    if (trigger === 'update' && session?.tenantId) {
      // Org switch: update active tenant in token
      token.tenantId = session.tenantId;
      token.role = session.role;
    }
    if (account && user) {
      // Initial sign-in: load tenant membership
      const membership = await getDefaultTenantMembership(token.sub ?? user.id);
      token.tenantId = membership?.tenantId ?? null;
      token.role = membership?.role ?? null;
      token.isSuperAdmin = await isSuperAdmin(token.sub ?? user.id);
    }
    return token;
  },
  async session({ session, token }) {
    session.user.tenantId = token.tenantId;
    session.user.role = token.role;
    session.user.isSuperAdmin = token.isSuperAdmin;
    return session;
  }
}
```

The `trigger === 'update'` path is how org switching works: the client calls `update({ tenantId, role })` from `next-auth/react` after the user picks a different org, which re-runs the JWT callback and refreshes the session cookie.

### Modified: `web-ui/lib/auth-session.ts`

Add helpers that API routes use to extract tenant context:

```typescript
export async function getSessionTenantId(): Promise<string> {
  const session = await getServerSession(authOptions);
  const tenantId = (session?.user as any)?.tenantId;
  if (!tenantId) throw new Error('No active tenant in session');
  return tenantId;
}

export async function getSessionRole(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return (session?.user as any)?.role ?? null;
}

export async function assertSuperAdmin(): Promise<void> {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isSuperAdmin) {
    throw new Error('Forbidden: super-admin only');
  }
}
```

Alternatively, API routes can read `x-tenant-id` from the injected header (faster — no session re-fetch):

```typescript
// In an API route handler
export async function GET(req: NextRequest) {
  const tenantId = req.headers.get('x-tenant-id');
  if (!tenantId) return NextResponse.json({ error: 'No tenant context' }, { status: 400 });
  // ...
}
```

### Replaced: `web-ui/lib/rbac/`

Remove all CASL imports (`@casl/ability`). Replace `authorize()` with a custom function that reads the role from the session and checks against a static permission map.

New structure:

```
web-ui/lib/rbac/
  types.ts          — keep TenantRole, Actions, Subjects (remove AppAbility/PureAbility)
  permissions.ts    — static ROLE_PERMISSIONS map (replaces abilities.ts)
  authorize.ts      — new authorize() using permissions map (replaces CASL)
  role-service.ts   — unchanged (delegates to IRbacRepository)
```

New `permissions.ts` pattern:

```typescript
// No CASL — plain object lookup
export const ROLE_PERMISSIONS: Record<TenantRole | 'SuperAdmin', Set<string>> = {
  SuperAdmin:      new Set(['*']),
  TenantAdmin:     new Set(['Account:read','Account:create','Account:update','Account:delete','Schedule:*','User:*','Agent:use',...]),
  TenantOperator:  new Set(['Account:read','Schedule:*','Schedule:execute','AuditLog:read',...]),
  TenantViewer:    new Set(['Account:read','Schedule:read','AuditLog:read',...]),
};

export function can(role: string, action: Actions, subject: Subjects): boolean {
  const perms = ROLE_PERMISSIONS[role as TenantRole];
  if (!perms) return false;
  if (perms.has('*')) return true;
  return perms.has(`${subject}:${action}`) || perms.has(`${subject}:*`);
}
```

New `authorize.ts` — reads role from session, no CASL:

```typescript
export async function authorize(action: Actions, subject: Subjects): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  const role = (session?.user as any)?.role;
  const isSuperAdmin = (session?.user as any)?.isSuperAdmin;

  if (isSuperAdmin || can(role, action, subject)) return null;

  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
```

### Modified: Prisma Schema

New models needed:

```prisma
// User — for CredentialsProvider auth (Prisma adapter pattern)
model User {
  id            String    @id @default(cuid())
  email         String    @unique
  name          String?
  passwordHash  String?   // null for Cognito-only users
  isSuperAdmin  Boolean   @default(false)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  memberships   TenantMembership[]
  invitations   Invitation[]

  @@map("users")
}

// TenantMembership — replaces UserTenantRole (same data, cleaner name)
// Keep UserTenantRole table for backward compat; add this as the v3 model
model TenantMembership {
  id        String   @id @default(cuid())
  userId    String
  tenantId  String
  role      String   // TenantAdmin | TenantOperator | TenantViewer
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([userId, tenantId])
  @@index([tenantId])
  @@map("tenant_memberships")
}

// Invitation — email invite flow
model Invitation {
  id         String    @id @default(cuid())
  tenantId   String
  email      String
  role       String
  token      String    @unique  // secure random token in URL
  invitedBy  String             // userId of inviter
  status     String    @default("pending") // pending|accepted|declined|expired
  expiresAt  DateTime
  createdAt  DateTime  @default(now())
  acceptedAt DateTime?

  inviter User   @relation(fields: [invitedBy], references: [id])
  tenant  Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([token])
  @@map("invitations")
}
```

Modify existing `Tenant` model:

```prisma
model Tenant {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique  // URL-safe identifier
  status      String   @default("active") // active|suspended|pending
  suspendedAt DateTime?
  suspendedBy String?
  settings    Json     @default("{}")  // branding, timezone, notifications
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  configs     TenantConfig[]
  memberships TenantMembership[]
  invitations Invitation[]

  @@map("tenants")
}
```

---

## Data Flow Changes

### Request Flow (after v3.0)

```
Browser Request
    ↓
middleware.ts
  → check token.isSuperAdmin for /admin routes
  → inject x-tenant-id header from token.tenantId
    ↓
API Route Handler
  → read tenantId from x-tenant-id header (or getSessionTenantId())
  → authorize(action, subject) — checks role from session
  → check tenant status (suspended tenants → 403 on mutating ops)
    ↓
Service Layer
  → receives tenantId explicitly (no DEFAULT_TENANT_ID fallback)
  → passes tenantId to repository
    ↓
Repository (Prisma)
  → WHERE tenant_id = tenantId on every query
    ↓
PostgreSQL
```

### Org Switch Flow

```
User clicks org in header dropdown
    ↓
OrgSwitcher component calls update({ tenantId, role }) from next-auth/react
    ↓
NextAuth JWT callback (trigger === 'update') updates token.tenantId + token.role
    ↓
Session cookie refreshed with new tenantId
    ↓
Client router.refresh() — all server components re-render with new tenant context
    ↓
All API calls now carry new x-tenant-id header
```

### Invitation Flow

```
TenantAdmin POSTs /api/invitations { email, role }
    ↓
InvitationService.create() — generates crypto token, stores in invitations table, sends email
    ↓
Invitee clicks link: GET /invite/[token]
    ↓
/app/invite/[token] page — validates token, shows accept/decline UI
    ↓
POST /api/invitations/[token]/accept
    ↓
InvitationService.accept() — creates User (if new) + TenantMembership, marks invitation accepted
    ↓
Redirect to /login (or auto-sign-in if already authenticated)
```

### Tenant Suspension Flow

```
SuperAdmin POSTs /api/admin/tenants/[id]/suspend
    ↓
TenantService.suspend() — sets tenant.status = 'suspended', records suspendedAt + suspendedBy
    ↓
Middleware reads tenant status on each request (cached in token or checked per-request)
    ↓
Suspended tenant users: read-only access (GET allowed, mutations return 423 Locked)
    ↓
SuperAdmin POSTs /api/admin/tenants/[id]/unsuspend → status = 'active'
```

---

## New Route Structure

### Admin Panel (`/app/app/admin/`)

```
web-ui/app/app/admin/
  layout.tsx              — super-admin guard (existing, uses CASL — replace with isSuperAdmin check)
  page.tsx                — admin dashboard (tenant count, recent activity)
  tenants/
    page.tsx              — list all tenants (status, user count, created date)
    new/
      page.tsx            — onboard new tenant form
    [tenantId]/
      page.tsx            — tenant detail (settings, users, suspension controls)
  users/
    page.tsx              — existing stub (list all users across tenants)
```

### Admin API (`/web-ui/app/api/admin/`)

```
web-ui/app/api/admin/
  tenants/
    route.ts              — GET (list all), POST (create tenant + root user)
    [tenantId]/
      route.ts            — GET (detail), PATCH (settings), DELETE (soft-delete)
      suspend/
        route.ts          — POST (suspend), DELETE (unsuspend)
      users/
        route.ts          — GET (list tenant users)
  users/
    route.ts              — GET (list all users platform-wide)
    role/
      route.ts            — existing POST (assign role) — keep, update to use new RBAC
```

### Invitation API

```
web-ui/app/api/invitations/
  route.ts                — POST (create invitation, send email)
  [token]/
    route.ts              — GET (validate token), POST (accept), DELETE (decline)
```

### Invitation UI

```
web-ui/app/invite/
  [token]/
    page.tsx              — accept/decline invitation page (public, no auth required)
```

---

## Lambda Tenant Awareness

The scheduler Lambda (`lambda/scheduler/`) reads schedules from the database and executes them. It already has `tenantId` on schedule records from v1.0. Required changes are minimal:

| Lambda | Change Needed |
|--------|--------------|
| `scheduler` | Verify all DB queries include `tenantId` filter; skip schedules for suspended tenants (check `tenant.status` before executing) |
| `discovery` | Already scoped by AWS account; `tenantId` on inventory records is set at write time — no change needed |
| `vector_processor` | Reads from S3, writes to S3 Vectors — no tenant context needed at this layer |
| `kb_sync_processor` | Reads `tenantId` from the KB record it processes — already scoped |

The scheduler Lambda needs one new check: before executing a schedule, verify the owning tenant is not suspended. This requires a lightweight DB query or a cached tenant status lookup.

---

## Recommended Build Order

Dependencies flow strictly top-to-bottom. Each phase unblocks the next.

### Phase 1: Foundation (Prisma + Auth)
Build first because everything else depends on it.
- Add `User`, `TenantMembership`, `Invitation` Prisma models; add `status`/`slug`/`settings` to `Tenant`
- Add CredentialsProvider to `auth-options.ts`; extend JWT/session callbacks with `tenantId`, `role`, `isSuperAdmin`
- Add `getSessionTenantId()`, `getSessionRole()`, `assertSuperAdmin()` to `auth-session.ts`
- Update `middleware.ts` with tenant header injection + super-admin route guard

### Phase 2: Custom RBAC (replaces CASL)
Depends on Phase 1 (role is now in session).
- Remove `@casl/ability` imports from all files
- Write `permissions.ts` with static `ROLE_PERMISSIONS` map
- Rewrite `authorize.ts` to use permissions map instead of CASL
- Update all API routes that call `authorize()` — signature stays the same, internals change
- Remove `AbilityContext.tsx`, `server-ability.ts`, `abilities.ts`

### Phase 3: Tenant Context Enforcement
Depends on Phase 1 (tenantId in session) and Phase 2 (new authorize).
- Replace all `DEFAULT_TENANT_ID` fallbacks with `getSessionTenantId()` in API routes
- Add tenant suspension check in middleware or a shared API helper
- Update service layer to require explicit `tenantId` (remove default parameter)

### Phase 4: Org Switching
Depends on Phase 1 (tenantId in JWT) and Phase 3 (tenant-scoped data).
- Build `OrgSwitcher` component — calls `update()` from `next-auth/react`
- Add `getUserTenants()` to `role-service.ts` (list all tenants a user belongs to)
- Wire into header/sidebar

### Phase 5: Super Admin Panel
Depends on Phase 1 (super-admin guard) and Phase 3 (tenant CRUD).
- Build `TenantService` (create, list, suspend, unsuspend, settings)
- Build `/api/admin/tenants/**` routes
- Build `/app/admin/tenants/**` pages

### Phase 6: User Invitations
Depends on Phase 1 (User model) and Phase 5 (tenant exists before inviting).
- Build `InvitationService` (create token, send email, accept, decline)
- Build `/api/invitations/**` routes
- Build `/app/invite/[token]` page

### Phase 7: Tenant Settings UI
Depends on Phase 5 (tenant model has settings field).
- Build settings form (branding, timezone, notifications)
- Wire to `TenantConfigService` or directly to `Tenant.settings` JSON field

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: DEFAULT_TENANT_ID as a fallback

**What people do:** Keep `DEFAULT_TENANT_ID = 'default'` as a fallback when tenantId is missing from session.
**Why it's wrong:** Silently serves wrong-tenant data. A missing tenantId means the session is broken — it should be a hard error, not a silent fallback.
**Do this instead:** `getSessionTenantId()` throws if tenantId is absent. API routes catch and return 400/401.

### Anti-Pattern 2: Checking tenant status in every service method

**What people do:** Add `if (tenant.status === 'suspended') throw ...` inside each service.
**Why it's wrong:** Duplicated logic, easy to miss a service, inconsistent error responses.
**Do this instead:** Single suspension check in middleware (for page routes) and a shared `assertTenantActive(tenantId)` helper called once at the top of each API route handler.

### Anti-Pattern 3: Storing tenantId only in the JWT, not verifying it

**What people do:** Trust `token.tenantId` without verifying the user still has membership in that tenant.
**Why it's wrong:** If a user is removed from a tenant, their existing JWT still carries the old tenantId until it expires.
**Do this instead:** On JWT refresh (every `session.maxAge` interval), re-validate membership. Or check membership on sensitive operations (role assignment, account creation).

### Anti-Pattern 4: Super-admin as a tenant member

**What people do:** Add the super-admin user to every tenant's `user_tenant_roles` table.
**Why it's wrong:** Pollutes tenant user lists, creates confusion about data ownership, breaks tenant isolation semantics.
**Do this instead:** Super-admin is identified by `User.isSuperAdmin = true`. They bypass tenant checks entirely via the `isSuperAdmin` flag in the JWT — they are never a member of any tenant.

### Anti-Pattern 5: Rebuilding CASL with a custom library

**What people do:** Reach for another ABAC library (e.g., `accesscontrol`, `node-casbin`) to replace CASL.
**Why it's wrong:** The permission model here is simple role-based (4 roles, ~5 subjects, ~5 actions). A static lookup table is 20 lines and zero dependencies.
**Do this instead:** `ROLE_PERMISSIONS` map in `permissions.ts`. Add complexity only if per-resource conditions are needed.

---

## Scalability Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1-50 tenants | Current approach — session-based tenantId, row-level isolation, no caching needed |
| 50-500 tenants | Cache tenant status in Redis/Upstash to avoid DB hit on every request for suspension check |
| 500+ tenants | Consider tenant-aware connection pooling (PgBouncer per tenant); evaluate schema-per-tenant for largest customers |

The current row-level isolation approach (single schema, `tenant_id` column) is the right choice for this scale. Schema-per-tenant adds operational complexity that isn't justified until you have compliance requirements or very large per-tenant data volumes.

---

## Sources

- Next.js App Router middleware docs: https://nextjs.org/docs/app/building-your-application/routing/middleware (HIGH)
- NextAuth JWT `trigger: 'update'` for session mutation: https://next-auth.js.org/configuration/callbacks#jwt-callback (HIGH)
- NextAuth CredentialsProvider: https://next-auth.js.org/providers/credentials (HIGH)
- Prisma schema relations: https://www.prisma.io/docs/orm/prisma-schema/data-model/relations (HIGH)
- Row-level multi-tenancy pattern: direct codebase analysis of existing `tenant_id` columns (HIGH)
- CASL removal rationale: codebase analysis — `@casl/ability` in `web-ui/lib/rbac/` (HIGH)

---
*Architecture research for: v3.0 Multi-Tenancy on Nucleus Cloud Ops*
*Researched: 2026-03-31*

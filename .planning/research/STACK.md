# Stack Research: Multi-Tenancy (v3.0)

**Project:** Nucleus Cloud Ops — v3.0 Multi-Tenancy
**Researched:** 2026-03-31
**Scope:** Stack additions/changes for multi-tenancy, custom RBAC, dual auth, user invitations, tenant suspension, and tenant-level settings. Existing validated stack (Next.js 15, Prisma 5, NextAuth v4, Tailwind, Radix UI) is NOT re-researched.
**Confidence:** HIGH

---

## New Dependencies

### Auth — Dual Auth (Cognito + Credentials)

| Package | Version | Purpose | Why |
|---------|---------|---------|-----|
| `@next-auth/prisma-adapter` | `^1.0.7` | Persist NextAuth users/sessions/accounts in PostgreSQL | Required for Credentials provider — NextAuth needs a database adapter to store user records when using username/password auth. Cognito-only auth didn't need this because Cognito managed user storage. |
| `bcryptjs` | `^3.0.3` | Hash and verify passwords for Credentials provider | Pure JavaScript — no native bindings. `bcrypt` (native) requires build tools and causes Docker layer issues. `bcryptjs` is identical API, works in Node 20 ECS Fargate without any native compilation. |
| `@types/bcryptjs` | `^3.0.0` | TypeScript types for bcryptjs | Dev dependency only. |

**Confidence:** HIGH — versions verified from npm registry 2026-03-31.

**Critical note on `@next-auth/prisma-adapter` vs `@auth/prisma-adapter`:** The project uses `next-auth ^4`. The `@auth/prisma-adapter` package is for Auth.js v5 (the rewrite). Do NOT install `@auth/prisma-adapter` — it is incompatible with next-auth v4. Use `@next-auth/prisma-adapter` which explicitly declares `peerDependencies: { "next-auth": "^4" }`.

**Prisma models required by the adapter** (must be added to `prisma/schema.prisma`):

```prisma
model AuthUser {
  id            String    @id @default(cuid())
  name          String?
  email         String?   @unique
  emailVerified DateTime?
  image         String?
  passwordHash  String?   // Added for Credentials provider
  accounts      AuthAccount[]
  sessions      AuthSession[]

  @@map("auth_users")
}

model AuthAccount {
  id                String  @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String? @db.Text
  access_token      String? @db.Text
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String? @db.Text
  session_state     String?
  user              AuthUser @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerAccountId])
  @@map("auth_accounts")
}

model AuthSession {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  user         AuthUser @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("auth_sessions")
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime

  @@unique([identifier, token])
  @@map("verification_tokens")
}
```

**Why `@@map("auth_users")` and `@@map("auth_accounts")`:** The existing schema already has an `Account` model (AWS cloud accounts) mapped to `"accounts"`. NextAuth's adapter also needs an `Account` model for OAuth provider tokens. Using `AuthUser`/`AuthAccount` as Prisma model names with explicit `@@map` directives avoids the naming collision while keeping the database table names clean.

---

### Email — User Invitations

| Package | Version | Purpose | Why |
|---------|---------|---------|-----|
| `resend` | `^6.10.0` | Send transactional emails (invitations, welcome, suspension notices) | API-first email service — no SMTP config, no deliverability tuning. Free tier: 3,000 emails/month. React Email integration is first-class. Nodemailer requires an SMTP relay (SES, SendGrid) and separate deliverability setup. |
| `@react-email/components` | `^1.0.10` | Build HTML email templates with React components | Renders to email-safe HTML. Pairs with Resend. Keeps email templates in the same React/TypeScript codebase. |
| `react-email` | `^5.2.10` | Dev server for previewing email templates locally | Dev dependency only — `npm install -D react-email`. Run `email dev` to preview templates at localhost:3000. |

**Confidence:** HIGH — versions verified from npm registry 2026-03-31.

**Usage pattern:**

```typescript
// web-ui/lib/email/send-invitation.ts
import { Resend } from 'resend';
import { InvitationEmail } from '@/emails/invitation';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendInvitationEmail(to: string, inviteUrl: string, tenantName: string) {
  const { data, error } = await resend.emails.send({
    from: 'Nucleus <noreply@yourdomain.com>',
    to,
    subject: `You've been invited to ${tenantName}`,
    react: InvitationEmail({ inviteUrl, tenantName }),
  });
  if (error) throw new Error(`Email send failed: ${error.message}`);
  return data;
}
```

---

### RBAC — Custom (No New Library)

**Decision: Build custom RBAC with Prisma. No library.**

Rationale: The requirement is granular per-module permissions stored in PostgreSQL, with custom roles per tenant. Libraries like `casbin`, `accesscontrol`, or `permify` add abstraction layers that fight against Prisma's query model. A custom implementation is ~100 lines and gives full control over the data model.

**Prisma models to add:**

```prisma
model Role {
  id          String       @id @default(cuid())
  tenantId    String
  name        String       // "admin" | "viewer" | "operator" | custom
  description String?
  isSystem    Boolean      @default(false) // system roles can't be deleted
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  permissions RolePermission[]
  userRoles   UserRole[]

  @@unique([tenantId, name])
  @@index([tenantId])
  @@map("roles")
}

model RolePermission {
  id       String @id @default(cuid())
  roleId   String
  module   String // "Accounts" | "Schedules" | "AiOps" | "Inventory"
  action   String // "create" | "read" | "update" | "delete"
  role     Role   @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@unique([roleId, module, action])
  @@index([roleId])
  @@map("role_permissions")
}

model UserRole {
  id         String   @id @default(cuid())
  userId     String
  tenantId   String
  roleId     String
  assignedAt DateTime @default(now())
  assignedBy String
  role       Role     @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@unique([userId, tenantId, roleId])
  @@index([userId, tenantId])
  @@map("user_roles")
}
```

**Authorization function pattern** (replaces CASL's `authorize()`):

```typescript
// web-ui/lib/rbac/authorize.ts (rewritten — no @casl/ability import)
export async function authorize(
  userId: string,
  tenantId: string,
  module: Module,
  action: Action
): Promise<NextResponse | null> {
  const allowed = await hasPermission(userId, tenantId, module, action);
  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

async function hasPermission(userId: string, tenantId: string, module: Module, action: Action) {
  const count = await prisma.rolePermission.count({
    where: {
      role: { userRoles: { some: { userId, tenantId } } },
      module,
      action,
    },
  });
  return count > 0;
}
```

Cache this per-request in a `Map` keyed by `${userId}:${tenantId}` to avoid N+1 queries per API route.

---

### Tenant Lifecycle — No New Library

**Tenant suspension, onboarding, and settings** are pure Prisma + Next.js API routes. No new library needed.

**Prisma additions to `Tenant` model:**

```prisma
model Tenant {
  id          String       @id @default(cuid())
  name        String
  slug        String       @unique  // URL-safe identifier
  status      String       @default("active") // active|suspended|pending
  suspendedAt DateTime?
  suspendedBy String?
  suspendReason String?
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  configs     TenantConfig[]
  roles       Role[]
  invitations Invitation[]

  @@map("tenants")
}
```

**Invitation model:**

```prisma
model Invitation {
  id         String    @id @default(cuid())
  tenantId   String
  email      String
  roleId     String
  token      String    @unique  // crypto.randomBytes(32).toString('hex')
  status     String    @default("pending") // pending|accepted|declined|expired
  invitedBy  String
  expiresAt  DateTime  // 7 days from creation
  acceptedAt DateTime?
  createdAt  DateTime  @default(now())

  tenant     Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([token])
  @@index([email, tenantId])
  @@map("invitations")
}
```

Invitation tokens use `crypto.randomBytes(32).toString('hex')` — Node.js built-in, no library needed.

---

### Tenant Context Middleware — No New Library

Next.js `middleware.ts` handles tenant context injection. No library needed.

```typescript
// web-ui/middleware.ts
import { getToken } from 'next-auth/jwt';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const token = await getToken({ req: request });

  // Inject tenant context as header for API routes
  const requestHeaders = new Headers(request.headers);
  if (token?.activeTenantId) {
    requestHeaders.set('x-tenant-id', token.activeTenantId as string);
  }

  // Block suspended tenant access (except /admin and /api/auth)
  if (token?.tenantStatus === 'suspended' && !request.nextUrl.pathname.startsWith('/admin')) {
    return NextResponse.redirect(new URL('/suspended', request.url));
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

`getToken` is already exported from `next-auth/jwt` — no new import needed.

---

## Packages to Remove

| Package | Why Remove |
|---------|-----------|
| `@casl/ability` | Replaced by custom Prisma-backed RBAC. All `@casl/ability` imports must be removed before new RBAC goes live. |
| `@casl/react` | React context for CASL — no longer needed. |

```bash
npm uninstall @casl/ability @casl/react
```

---

## Installation

```bash
# New runtime dependencies
npm install @next-auth/prisma-adapter bcryptjs resend @react-email/components

# New dev dependencies
npm install -D @types/bcryptjs react-email

# Remove CASL
npm uninstall @casl/ability @casl/react
```

Run from `web-ui/` directory.

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| `@next-auth/prisma-adapter` | `@auth/prisma-adapter` | Auth.js v5 adapter — incompatible with next-auth v4. Would require upgrading NextAuth (major breaking change, out of scope). |
| `bcryptjs` | `bcrypt` (native) | Native bindings require build tools in Docker. Causes `node-pre-gyp` failures in Alpine/slim images. Same API, no reason to use native. |
| `resend` | `nodemailer` + SES | Nodemailer requires SMTP relay config, SES domain verification, bounce/complaint handling setup. Resend handles all of this. |
| `resend` | `@aws-sdk/client-ses` | SES SDK requires domain verification, IAM permissions, bounce/complaint SNS topics. Resend is faster to ship. |
| Custom RBAC | `casbin` | Casbin uses policy files/adapters with its own DSL. Overkill for a Prisma-native permission model. Adds ~200KB bundle. |
| Custom RBAC | `accesscontrol` | Last published 2019, unmaintained. |
| Custom RBAC | `permify` | Requires a separate Permify service (gRPC). Adds infrastructure dependency for a feature that's 100 lines of Prisma. |
| Next.js middleware | `@clerk/nextjs` | Clerk is a full auth platform — would replace NextAuth entirely. Out of scope for this milestone. |

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@auth/prisma-adapter` | Auth.js v5 — incompatible with next-auth v4 | `@next-auth/prisma-adapter` |
| `bcrypt` | Native bindings, Docker build issues | `bcryptjs` |
| `nodemailer` | SMTP config complexity, deliverability setup | `resend` |
| `iron-session` | Session management — NextAuth already handles this | NextAuth JWT callbacks |
| `jose` | JWT library — NextAuth already uses it internally | NextAuth's `getToken()` |
| `next-auth` v5 / Auth.js | Major breaking change, different API surface | Stay on next-auth v4.24.x |
| Any RBAC library | Adds abstraction over Prisma queries that don't need it | Custom `hasPermission()` backed by Prisma |
| `uuid` for invitation tokens | Overkill — UUIDs are not cryptographically random enough for security tokens | `crypto.randomBytes(32).toString('hex')` |

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `@next-auth/prisma-adapter@1.0.7` | `next-auth@^4`, `@prisma/client@>=2.26.0` | Both satisfied by existing deps |
| `bcryptjs@3.0.3` | Node.js 20+ | Pure JS, no native deps |
| `resend@6.10.0` | Node.js 18+ | Works in ECS Fargate Node 20 |
| `@react-email/components@1.0.10` | React 18+ | React 19 compatible |

---

## Environment Variables to Add

```bash
# .env.local additions for v3.0
RESEND_API_KEY=re_...          # From resend.com dashboard
RESEND_FROM_EMAIL=noreply@yourdomain.com  # Must be verified domain in Resend

# NextAuth — already present, no change needed
NEXTAUTH_SECRET=...
NEXTAUTH_URL=...
```

---

## Sources

- `@next-auth/prisma-adapter` version + peer deps: `npm show @next-auth/prisma-adapter` (verified 2026-03-31)
- `bcryptjs` version: `npm show bcryptjs version` → 3.0.3 (verified 2026-03-31)
- `resend` version: `npm show resend version` → 6.10.0 (verified 2026-03-31)
- `@react-email/components` version: `npm show @react-email/components version` → 1.0.10 (verified 2026-03-31)
- `react-email` version: `npm show react-email version` → 5.2.10 (verified 2026-03-31)
- NextAuth Prisma adapter required models: https://authjs.dev/getting-started/adapters/prisma (MEDIUM — page confirmed models, version not shown)
- Resend Node.js usage: https://resend.com/docs/send-with-nodejs (HIGH — official docs)
- NextAuth v4 Credentials provider: https://next-auth.js.org/providers/credentials (existing project knowledge, HIGH)

---
*Stack research for: Multi-Tenancy v3.0 — Nucleus Cloud Ops*
*Researched: 2026-03-31*

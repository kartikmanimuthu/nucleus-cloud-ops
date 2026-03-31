---
phase: 12-auth-foundation
plan: "01"
subsystem: auth
tags: [nextauth, prisma-adapter, credentials, cognito, database-sessions, bcrypt]
dependency_graph:
  requires: []
  provides: [auth-models, dual-auth-config, session-normalization]
  affects: [web-ui/lib/auth-options.ts, prisma/schema.prisma]
tech_stack:
  added: ["@auth/prisma-adapter@^2.11.1", "bcryptjs@^3.0.3", "@types/bcryptjs@^2.4.6"]
  patterns: [PrismaAdapter, database-sessions, CredentialsProvider, bcrypt-lockout]
key_files:
  created:
    - web-ui/lib/auth-types.ts
    - prisma/migrations/20260331_add_auth_models/migration.sql
  modified:
    - prisma/schema.prisma
    - web-ui/lib/auth-options.ts
    - web-ui/package.json
decisions:
  - "PrismaAdapter proxy pattern: map AuthUser/AuthAccount/AuthSession to adapter's user/account/session keys to avoid collision with existing Account model"
  - "Database session strategy (not JWT) — required for suspension enforcement in Phase 15"
  - "bcrypt cost factor 12 (default) for password hashing per D-12"
  - "5-attempt lockout with 15-minute window per D-11"
metrics:
  duration: "~15 minutes"
  completed: "2026-04-01"
  tasks: 2
  files: 5
---

# Phase 12 Plan 01: Prisma Adapter Models + Dual Auth Config Summary

NextAuth database sessions with PrismaAdapter, CredentialsProvider (bcrypt + lockout), CognitoProvider preserved, session normalized to `{ id, email, tenantId, role, isSuperAdmin }`.

## What Was Built

**Task 1 — Prisma adapter models + dependencies**

Added four NextAuth adapter models to `prisma/schema.prisma` mapped to `auth_*` tables:
- `AuthUser` — email, passwordHash, isSuperAdmin, failedAttempts, lockedUntil
- `AuthAccount` — OAuth account links (Cognito)
- `AuthSession` — database session tokens (24h TTL)
- `VerificationToken` — password reset tokens

Installed `@auth/prisma-adapter`, `bcryptjs`, `@types/bcryptjs`. Created `web-ui/lib/auth-types.ts` with NextAuth module augmentation for `Session`, `User`, and `AdapterUser`. Created migration SQL at `prisma/migrations/20260331_add_auth_models/migration.sql`.

**Task 2 — Rewrite auth-options.ts**

Rewrote `web-ui/lib/auth-options.ts` with:
- `PrismaAdapter` via proxy object mapping `AuthUser/AuthAccount/AuthSession` to adapter's expected model names
- `CredentialsProvider` with bcrypt password verification, 5-attempt lockout (15 min), and failed-attempt tracking
- `CognitoProvider` preserved with same env vars
- `session: { strategy: "database", maxAge: 86400 }` — 24h TTL
- `session` callback queries `userTenantRole` and normalizes shape to `{ id, email, tenantId, role, isSuperAdmin }`

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 8618199 | feat(12-01): add NextAuth Prisma adapter models + auth types |
| 2 | 1ff8b2d | feat(12-01): rewrite auth-options with dual providers + database sessions |

## Deviations from Plan

**1. [Rule 3 - Blocking] Manual migration file instead of `prisma migrate dev`**
- **Found during:** Task 1
- **Issue:** No running PostgreSQL instance in the worktree environment — `prisma migrate dev` requires a live DB connection
- **Fix:** Created migration SQL manually following the same pattern as existing migrations in `prisma/migrations/`
- **Files modified:** `prisma/migrations/20260331_add_auth_models/migration.sql`
- **Commit:** 8618199

## Decisions Made

1. PrismaAdapter proxy pattern — `prismaForAuth` object maps `user/account/session/verificationToken` keys to `prisma.authUser/authAccount/authSession/verificationToken` to satisfy adapter's expected model names without renaming existing `Account` model
2. Database session strategy confirmed — adds one DB lookup per request; acceptable at current scale; required for Phase 15 suspension enforcement
3. `bcrypt.compare` from `bcryptjs` (not `bcrypt`) — pure JS, no native bindings, works in Next.js edge/serverless

## Self-Check: PASSED

- FOUND: web-ui/lib/auth-types.ts
- FOUND: web-ui/lib/auth-options.ts
- FOUND: prisma/migrations/20260331_add_auth_models/migration.sql
- FOUND: commit 8618199
- FOUND: commit 1ff8b2d

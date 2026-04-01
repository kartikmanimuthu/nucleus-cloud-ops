# Phase 12: Auth Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-31
**Phase:** 12-auth-foundation
**Areas discussed:** Login UI design, Session migration strategy, Super admin bootstrapping, Password policy

---

## Login UI design

| Option | Description | Selected |
|--------|-------------|----------|
| Tabbed form | Single /login page with tabs: 'Email & Password' and 'SSO (Cognito)'. Clean, keeps everything in one place. | ✓ |
| Stacked form + SSO button | Single form with email/password fields + divider + 'Continue with Cognito' button below. No tabs. | |
| Separate routes | Credentials at /login, Cognito SSO at /login/sso. Separate pages, separate flows. | |
| You decide | Let Claude pick the best approach during implementation | |

**User's choice:** Tabbed form (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Inline field errors | Show error inline under the form field (red text below email/password). Standard pattern. | ✓ |
| Toast notifications | Toast notification at top-right corner. Less intrusive but easy to miss. | |
| Banner above form | Red banner above the form with the error message. Prominent but takes space. | |
| You decide | Let Claude decide the error display approach | |

**User's choice:** Inline field errors (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, built-in reset flow | Show 'Forgot password?' link on Credentials tab. Sends reset email via NextAuth's built-in flow. | ✓ |
| Defer to later phase | No password reset in Phase 12. Users contact admin to reset. | |
| You decide | Let Claude decide | |

**User's choice:** Yes, built-in reset flow (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Email & Password tab | Default to Email & Password tab. Most users will be Credentials-based managed users. | ✓ |
| SSO tab | Default to SSO tab. Enterprise users with Cognito are the primary audience. | |
| Remember last used | Remember the user's last-used tab via localStorage. | |
| You decide | Let Claude decide | |

**User's choice:** Email & Password tab (Recommended)
**Notes:** None

---

## Session migration strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Hard cutover | Deploy database sessions, all existing JWT sessions become invalid. Users must re-login. Simple, clean break. | ✓ |
| Dual-read transition period | Accept both JWT and database sessions for a transition period (e.g., 1 week). More complex middleware. | |
| You decide | Let Claude decide the migration approach | |

**User's choice:** Hard cutover (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| 24 hours | Short enough to force re-auth regularly, long enough for a workday. Database sessions can be invalidated server-side. | ✓ |
| 7 days | Less friction for users, but suspended tenants keep access longer if session check is missed. | |
| 30 days sliding | Extends on activity. Maximum convenience but largest window for stale sessions. | |
| You decide | Let Claude decide based on security best practices | |

**User's choice:** 24 hours (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Every request | Check tenant status on every authenticated request in middleware. Small DB hit but instant suspension enforcement. | |
| Cached (5 min TTL) | Cache tenant status for 5 minutes. Reduces DB load but suspension takes up to 5 min to take effect. | ✓ |
| You decide | Let Claude decide | |

**User's choice:** Cached (5 min TTL)
**Notes:** User chose caching over per-request check to reduce DB load, accepting up to 5 min delay on suspension enforcement.

---

## Super admin bootstrapping

| Option | Description | Selected |
|--------|-------------|----------|
| Env var seed | Define SUPER_ADMIN_EMAIL in .env. On first login, that email gets isSuperAdmin=true. | |
| Seed script | CLI command that creates the super admin user in the database. Run once after deploy. | |
| First-user-wins | First user to register becomes super admin. No config needed but risky in production. | ✓ |
| You decide | Let Claude decide | |

**User's choice:** First-user-wins
**Notes:** User chose simplest approach despite production risk note.

| Option | Description | Selected |
|--------|-------------|----------|
| Platform-level only | Super admin is NOT a member of any tenant. Accesses /admin only. Matches PROJECT.md decision. | ✓ |
| Dual identity | Super admin can also be a member of tenants with a separate tenant role. | |
| You decide | Let Claude decide | |

**User's choice:** Platform-level only (Recommended)
**Notes:** Aligns with PROJECT.md key decision.

---

## Password policy

| Option | Description | Selected |
|--------|-------------|----------|
| Standard (8+ mixed case + number) | Minimum 8 chars, at least 1 uppercase, 1 lowercase, 1 number. No special char requirement. | ✓ |
| Length-based (12+ any chars) | Minimum 12 chars, any mix. Length-based security is stronger than complexity rules. | |
| Minimal (8+ no rules) | Minimum 8 chars, no complexity rules. Simplest, relies on bcrypt cost factor. | |
| You decide | Let Claude decide based on security best practices | |

**User's choice:** Standard (8+ mixed case + number) (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Temporary lockout (5 attempts / 15 min) | Lock account for 15 minutes after 5 failed attempts. Prevents brute force without permanent lockout. | ✓ |
| Progressive delay | Add progressive delay between attempts. No hard lockout but slows brute force. | |
| Defer lockout | No lockout in Phase 12. Add rate limiting later. | |
| You decide | Let Claude decide | |

**User's choice:** Temporary lockout (5 attempts / 15 min) (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Cost factor 12 | ~250ms hash time. Good balance of security vs login latency. Industry standard. | ✓ |
| Cost factor 10 | ~100ms. Faster but slightly less resistant to brute force. | |
| You decide | Let Claude decide | |

**User's choice:** Cost factor 12 (Recommended)
**Notes:** None

---

## Claude's Discretion

- Prisma adapter model naming (AuthUser, AuthAccount, AuthSession — @@map to auth_* tables)
- x-tenant-id header injection implementation details in middleware
- Cognito callback handling and token extraction
- Password reset email template content
- Loading skeleton design on login page
- Error state handling for Cognito provider failures

## Deferred Ideas

None — discussion stayed within phase scope.

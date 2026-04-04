# Phase 15: Self-Service Signup - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-01
**Phase:** 15-super-admin-onboarding-suspension
**Areas discussed:** Onboarding model, Signup flow, Org creation, Admin panel scope

---

## Onboarding Model (scope pivot)

| Option | Description | Selected |
|--------|-------------|----------|
| Admin-initiated (original) | Super admin creates tenants from /admin panel. More control but creates bottleneck. | |
| Self-service | Signup creates user + tenant atomically. Admin panel is monitoring + suspension only. | ✓ |
| Hybrid | Both paths — self-service + admin can also create tenants manually. | |

**User's choice:** Self-service
**Notes:** User proposed self-service before options were presented. Rationale: "if a user signs up for a plan, he can be onboarded as a tenant with admin role by default... no need of a separate administration panel for tenant onboarding."

---

## Admin Panel + Suspension Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Keep monitoring + suspension | Admin panel as monitoring dashboard + suspension enforcement tool | |
| Defer entirely | No admin panel, no suspension in this phase | ✓ |

**User's choice:** Defer entirely
**Notes:** User said "suspension and monitoring is not needed now for the current project." ADMIN-01–07 and SUSP-01–04 all deferred.

---

## Phase 15 Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Self-service signup only | Phase 15 delivers self-service signup only. Admin panel and suspension deferred. | ✓ |
| Merge into Phase 16 | Remove Phase 15, fold signup into Phase 16 invitations. | |
| Something else | Keep Phase 15 with different scope. | |

**User's choice:** Self-service signup only

---

## Signup Flow

| Option | Description | Selected |
|--------|-------------|----------|
| Single-step form | Single page: org name, slug, email, password. Creates user + tenant atomically. | |
| Two-step wizard | Step 1: email + password. Step 2: org name + slug + timezone. | |
| Post-login org creation | Step 1: email + password (creates user). Step 2: /create-org after first login. | ✓ |

**User's choice:** Post-login org creation
**Notes:** Decouples user identity from tenant membership. Sets up well for Phase 16 where existing users accept invites.

---

## Auth Providers at Signup

| Option | Description | Selected |
|--------|-------------|----------|
| Credentials only | Email + password only. Cognito users pre-provisioned or via invitations. | |
| Both providers | Credentials and Cognito SSO on signup page. Consistent with dual-auth. | ✓ |

**User's choice:** Both providers

---

## Org Creation Fields

| Option | Description | Selected |
|--------|-------------|----------|
| Name + slug only | Minimal friction. Timezone configured later in Phase 17. | ✓ |
| Name + slug + timezone | Slightly more setup but timezone useful for scheduling. | |
| Name only, auto-slug | Auto-generate slug from name. Least friction. | |

**User's choice:** Name + slug only

---

## No-Org State Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Redirect to /create-org | After login, if no tenant, redirect to /create-org. Block /app/* access. | ✓ |
| In-app prompt/modal | Show banner/modal inside app prompting org creation. | |

**User's choice:** Redirect to /create-org

---

## Slug Validation

| Option | Description | Selected |
|--------|-------------|----------|
| Standard slug | Lowercase alphanumeric + hyphens, 3-50 chars, unique. Validated on blur. | ✓ |
| Auto-suggest + override | Same rules but auto-suggest from org name as user types. | |

**User's choice:** Standard slug

---

## Signup Page Location

| Option | Description | Selected |
|--------|-------------|----------|
| Separate /signup page | New route with link from login page. | ✓ |
| Third tab on /login | Add "Sign Up" tab to existing login page. | |

**User's choice:** Separate /signup page

---

## Email Verification

| Option | Description | Selected |
|--------|-------------|----------|
| No verification | User signs up and can create org immediately. | ✓ |
| Email verification required | Must click link before creating org. Prevents spam. | |

**User's choice:** No verification

---

## Claude's Discretion

- Signup page layout and styling
- /create-org form design and validation UX
- Error handling for duplicate emails across providers
- Cognito user edge cases
- Middleware no-tenant redirect implementation
- API endpoint design for slug check and org creation

## Deferred Ideas

- Super admin panel (ADMIN-01–07) — future phase
- Suspension enforcement (SUSP-01–04) — future phase
- Admin audit logging (ADMIN-07) — future phase
- Email verification — can add later if needed
- Timezone at org creation — Phase 17
- Auto-suggest slug — decided against

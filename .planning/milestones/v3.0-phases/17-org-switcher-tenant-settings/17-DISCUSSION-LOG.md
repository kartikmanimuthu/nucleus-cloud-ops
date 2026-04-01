# Phase 17: Org Switcher + Tenant Settings - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-01
**Phase:** 17-org-switcher-tenant-settings
**Areas discussed:** Org switcher placement, Tenant switch mechanism, Settings form scope, Logo upload & storage
**Mode:** --auto (all decisions auto-selected)

---

## Org Switcher Placement

| Option | Description | Selected |
|--------|-------------|----------|
| Sidebar header | Above nav items, standard SaaS pattern (Linear, Slack, Notion) | ✓ |
| Top header bar | Next to breadcrumbs or page title | |
| User dropdown submenu | Nested inside existing user menu | |

**User's choice:** Sidebar header (auto-selected — recommended default)
**Notes:** Sidebar already has user session data via useSession(). Org switcher naturally fits above navigation.

## Org Switcher Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| API call + session update() + router.refresh() | Proven pattern from create-org flow, no full reload | ✓ |
| Full page reload with new tenantId | Simpler but worse UX | |
| Client-side state only (no server round-trip) | Fast but risks stale data | |

**User's choice:** API call + session update() + router.refresh() (auto-selected — recommended default)
**Notes:** update() already proven in Phase 15 create-org. router.refresh() re-runs server components.

## Single-Org Visibility

| Option | Description | Selected |
|--------|-------------|----------|
| Show org name, no dropdown | Clean, per ORGW-04 requirement | ✓ |
| Hide org section entirely | Less context for user | |
| Show dropdown but disabled | Confusing UX | |

**User's choice:** Show org name but no dropdown/switcher (auto-selected — recommended default)
**Notes:** ORGW-04 explicitly requires hiding the switcher for single-org users.

## Settings Form Fields

| Option | Description | Selected |
|--------|-------------|----------|
| Name + timezone + notification preferences | Matches STNG-01 exactly | ✓ |
| Name + timezone only | Missing notification prefs from requirements | |
| Full settings (name, timezone, notifs, billing, branding) | Scope creep beyond STNG-01 | |

**User's choice:** Name + timezone + notification preferences (auto-selected — recommended default)
**Notes:** Slug stays read-only. Matches STNG-01 requirements exactly.

## Logo Upload Mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| S3 presigned URL + CloudFront serving | Existing infra, no API proxy overhead | ✓ |
| API proxy upload (multipart form) | Simpler client code but API bottleneck | |
| External service (Cloudinary, Uploadthing) | New dependency, overkill | |

**User's choice:** S3 presigned URL upload + CloudFront serving (auto-selected — recommended default)
**Notes:** Existing S3 + CloudFront infrastructure from Pulumi v2.0. Store path in TenantConfig.

## Logo Display Location

| Option | Description | Selected |
|--------|-------------|----------|
| Sidebar header next to org name | Natural placement with org switcher | ✓ |
| Top header bar | Separate from switcher | |
| Both sidebar and header | Redundant | |

**User's choice:** Sidebar header next to org name (auto-selected — recommended default)
**Notes:** STNG-02 says "header/sidebar". Sidebar header is where the org switcher lives.

## Settings Permissions

| Option | Description | Selected |
|--------|-------------|----------|
| Owner and Admin only | Matches STNG-03, consistent with RBAC hierarchy | ✓ |
| Owner only | Too restrictive | |
| All authenticated users | No access control | |

**User's choice:** Owner and Admin roles only (auto-selected — recommended default)
**Notes:** STNG-03 says "scoped to tenant-admin role". Owner + Admin consistent with Phase 13.

## Data Reload Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| router.refresh() server re-render | Next.js App Router pattern, middleware handles tenantId | ✓ |
| Full page reload | Works but poor UX | |
| Client-side cache invalidation | Complex, error-prone | |

**User's choice:** router.refresh() triggers server component re-render (auto-selected — recommended default)
**Notes:** Server components re-fetch with new x-tenant-id header from middleware.

## Claude's Discretion

- Exact sidebar switcher component design and animation
- How to persist "active tenant" (AuthUser column vs session-only)
- Timezone dropdown implementation
- Notification preferences structure
- S3 bucket selection for logo uploads
- Logo image processing approach
- Error handling for failed org switch

## Deferred Ideas

- Custom color theme per tenant (BRND-01) — v3.x
- Super admin panel (ADMIN-01–07) — future phase
- Tenant suspension enforcement (SUSP-01–04) — future phase

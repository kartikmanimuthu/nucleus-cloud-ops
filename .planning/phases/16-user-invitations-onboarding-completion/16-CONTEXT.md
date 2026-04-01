# Phase 16: User Invitations + Onboarding Completion - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Tenant admins can invite users via email using Cognito AdminCreateUser; invited users join the tenant with a pre-assigned role. Existing Cognito users invited to a second org are auto-joined with a notification email. Invitation management (view pending, resend, revoke) lives in a Members tab under /app/settings. Email delivery handled entirely by Cognito's built-in SES integration.

**Scope change from REQUIREMENTS.md:** ONBD-02 and ONBD-03 originally described "root user receives invitation email" for admin-initiated onboarding. Phase 15 changed to self-service signup, so ONBD-02/ONBD-03 are reinterpreted as: invited users (not root users) receive Cognito invitation emails and can set up their accounts.

</domain>

<decisions>
## Implementation Decisions

### Email provider
- **D-01:** AWS SES via Cognito — no Resend. Cognito's AdminCreateUser sends temp password emails through SES automatically. No separate SES SDK integration needed for invitations.
- **D-02:** Cognito's default invitation email template — no custom SES templates. Can customize later via Cognito console if needed.
- **D-03:** SES configuration managed by Cognito — no separate SES domain verification or DKIM/SPF setup beyond what Cognito requires.

### Invitation flow (new users)
- **D-04:** Cognito AdminCreateUser is the sole invitation mechanism. Admin provides email + role → backend calls AdminCreateUser → Cognito sends temp password email → user logs in with temp password → Cognito forces password change → user lands in the app with correct tenant and role.
- **D-05:** Cognito-only invitations — invited users always authenticate via Cognito. No Credentials (email/password) option for invited users. Existing Credentials users from Phase 15 self-service signup continue to work.
- **D-06:** Temp password expiry: 7 days (Cognito default TemporaryPasswordValidityDays). No override needed.

### Multi-org membership (existing users)
- **D-07:** When inviting an existing Cognito user to a second org, auto-join: create UserTenantRole record immediately, send notification email via SES ("You've been added to [Org]"). No accept/decline ceremony.
- **D-08:** Existing user detection: check AuthUser table by email before calling AdminCreateUser. If user exists in Cognito, skip AdminCreateUser and go straight to auto-join path.

### Invitation management UI
- **D-09:** New "Members" tab in /app/settings alongside existing "Roles" tab. Shows two sections: current members list + pending invitations list.
- **D-10:** Invite button opens a dialog: email input + role dropdown (respects hierarchy — can only assign roles at or below your level, per Phase 13 D-09).
- **D-11:** Pending invitations show: email, assigned role, invited date, expiry status. Actions: resend (calls AdminCreateUser again with RESEND MessageAction) and revoke.

### Revocation
- **D-12:** Revoke = AdminDisableUser in Cognito (if user hasn't set permanent password yet) + delete Invitation record from DB. Hard revoke — disabled Cognito user can't complete the flow.

### Invitation data model
- **D-13:** Invitation Prisma model stores: id, tenantId, email, role, invitedBy, status (pending/accepted/revoked/expired), createdAt, expiresAt. This is our local tracking — Cognito is the source of truth for auth state.
- **D-14:** On successful first login by invited user: mark Invitation as accepted, create UserTenantRole record if not already created.

### Claude's Discretion
- Invitation Prisma model exact field types and indexes
- Members tab layout and component structure
- Invite dialog form validation UX
- How to detect "first login after invitation" (Cognito user status check vs custom attribute)
- Notification email content for multi-org auto-join
- Error handling for AdminCreateUser failures (user pool limits, invalid email, etc.)
- Whether to show member count badge on Members tab
- Resend cooldown logic (if any)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Auth foundation (Phase 12 output)
- `web-ui/lib/auth-options.ts` — NextAuth config with Cognito provider, session callbacks
- `web-ui/lib/auth-session.ts` — `getSessionTenantId()`, `assertSuperAdmin()`, `getAuthSession()`
- `web-ui/lib/auth-types.ts` — Session type augmentation with tenantId, role, isSuperAdmin
- `web-ui/middleware.ts` — Current middleware with admin guard, x-tenant-id injection, no-tenant redirect

### RBAC (Phase 13 output)
- `web-ui/lib/rbac/types.ts` — PredefinedRole type (Owner, Admin, Member, Viewer), role hierarchy levels
- `web-ui/lib/rbac/authorize.ts` — authorize() function, role hierarchy enforcement (D-09 from Phase 13)

### Database schema
- `prisma/schema.prisma` — Tenant model (id, name, slug, status), AuthUser model, UserTenantRole model

### Existing settings UI
- `web-ui/app/app/settings/page.tsx` — Settings page with tabs (Roles tab exists)
- `web-ui/app/app/settings/roles/page.tsx` — Custom roles management page (reference for Members tab pattern)
- `web-ui/app/app/settings/layout.tsx` — Settings layout wrapper

### AWS SDK (Cognito)
- `web-ui/lib/aws-config.ts` — AWS SDK client initialization pattern (getDynamoDBDocumentClient — same pattern for CognitoIdentityProviderClient)

### Tenant isolation (Phase 14 output)
- `web-ui/lib/db/pg-config.ts` — `getTenantClient()` factory for scoped Prisma client

### Requirements
- `.planning/REQUIREMENTS.md` — INVT-01 through INVT-06, ONBD-02, ONBD-03

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `web-ui/app/app/settings/page.tsx`: Settings page with tab structure — add Members tab alongside Roles
- `web-ui/app/app/settings/roles/page.tsx`: Custom roles page — reference for table layout, dialogs, CRUD patterns
- `web-ui/components/ui/`: Dialog, Table, Input, Select, Button, Badge, Tabs primitives from Radix/shadcn
- `web-ui/lib/auth-options.ts`: Cognito provider config — has Cognito client ID and user pool ID
- `web-ui/lib/aws-config.ts`: AWS SDK client pattern — extend for CognitoIdentityProviderClient

### Established Patterns
- Settings page uses tab navigation with sub-pages (roles/ is a sub-route)
- API routes: `authorize()` → `getSessionTenantId()` → service call → `NextResponse.json()`
- Service layer: static classes with tenant-scoped methods
- Prisma models with tenantId + @@index([tenantId])
- Role hierarchy enforcement in Phase 13 (can only assign at or below your level)

### Integration Points
- `web-ui/app/app/settings/page.tsx`: Add "Members" tab linking to /app/settings/members
- `web-ui/app/app/settings/members/page.tsx`: New members management page
- `web-ui/app/api/invitations/route.ts`: New API for create/list/resend/revoke invitations
- `web-ui/app/api/settings/members/route.ts`: New API for listing current tenant members
- `prisma/schema.prisma`: Add Invitation model
- `web-ui/lib/invitation-service.ts`: New service for Cognito AdminCreateUser + Invitation CRUD
- `web-ui/lib/auth-options.ts`: May need hook to detect first login after invitation and create UserTenantRole

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for implementation details not covered by decisions above.

</specifics>

<deferred>
## Deferred Ideas

- **Custom SES email templates** — using Cognito defaults for now; can customize via Cognito console later
- **Invitation analytics** (INVT-08) — sent/accepted/expired/revoked counts dashboard. v3.x requirement.
- **Bulk invitation management** (INVT-07) — bulk resend/revoke. v3.x requirement.
- **Email verification on signup** — decided against in Phase 15, still deferred.
- **Resend (email provider)** — user explicitly chose AWS SES via Cognito over Resend.

</deferred>

---

*Phase: 16-user-invitations-onboarding-completion*
*Context gathered: 2026-04-01*

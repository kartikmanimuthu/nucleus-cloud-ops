# Phase 16: User Invitations + Onboarding Completion - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-01
**Phase:** 16-user-invitations-onboarding-completion
**Areas discussed:** Email delivery, Invitation flow, Multi-org membership, Invitation management UI, Token/expiry mechanics, Revocation

---

## Email Provider & Delivery

| Option | Description | Selected |
|--------|-------------|----------|
| Resend | Third-party email API (originally in requirements) | |
| AWS SES via Cognito | Cognito's built-in SES integration for invitation emails | ✓ |

**User's choice:** AWS SES via Cognito — user explicitly rejected Resend, wants to stay within AWS ecosystem.
**Notes:** User also wants Cognito for user invite and authentication, not just email. This shifted the entire phase architecture from custom token-based invitations to Cognito AdminCreateUser flow.

---

## Invitation Flow (Cognito)

| Option | Description | Selected |
|--------|-------------|----------|
| Cognito AdminCreateUser | Cognito sends temp password email via SES automatically. User logs in with temp password, forced to change. | ✓ |
| Custom invite + SES SDK | Generate own invite link, send via SES SDK directly. User clicks link, lands on custom accept page. | |

**User's choice:** Cognito AdminCreateUser (Recommended)
**Notes:** Simplest approach — Cognito handles the entire invitation email and password setup flow.

---

## Auth Provider for Invited Users

| Option | Description | Selected |
|--------|-------------|----------|
| Cognito-only invitations | All invited users go through Cognito. Existing Credentials users from Phase 12 signup still work. | ✓ |
| Dual-path (Cognito or Credentials) | Invited user can choose Cognito or set a local password. More complex. | |

**User's choice:** Cognito-only invitations (Recommended)
**Notes:** Keeps invitation flow simple. Self-service signup (Phase 15) still supports both providers.

---

## Multi-Org Membership (Existing Users)

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-join + notification | Create UserTenantRole immediately, send notification email. No accept/decline. | ✓ |
| Require explicit accept | Formal invite that existing user must accept before being added. | |

**User's choice:** Auto-join + notification (Recommended)
**Notes:** Less ceremony for existing users. They're already authenticated — just link them to the new tenant.

---

## Temp Password Expiry

| Option | Description | Selected |
|--------|-------------|----------|
| 7 days (Cognito default) | Cognito's default TemporaryPasswordValidityDays. Standard and simple. | ✓ |
| 48 hours (per requirements) | Override Cognito setting. Tighter security window, matches original INVT-02 spec. | |

**User's choice:** 7 days (Cognito default)
**Notes:** Simpler — no Cognito configuration override needed.

---

## Invitation Revocation

| Option | Description | Selected |
|--------|-------------|----------|
| Disable Cognito user + delete invite | AdminDisableUser if user hasn't set permanent password + delete Invitation record. Hard revoke. | ✓ |
| Soft revoke (DB only) | Mark invitation as revoked in DB. Cognito user stays, temp password naturally expires. | |

**User's choice:** Disable Cognito user + delete invite
**Notes:** Clean hard revoke — disabled Cognito user can't complete the flow.

---

## Email Template

| Option | Description | Selected |
|--------|-------------|----------|
| Cognito default template | Use Cognito's built-in invitation email. Quick to ship, customize later. | ✓ |
| Custom SES template | Suppress Cognito email, send custom via SES SDK. Full branding control. | |

**User's choice:** Cognito default template (Recommended)
**Notes:** Can customize later via Cognito console if needed.

---

## SES Configuration

| Option | Description | Selected |
|--------|-------------|----------|
| Cognito manages SES | Cognito uses SES under the hood. Just verify sender in SES. | ✓ |
| Separate SES config | Configure SES separately with verified domain, DKIM/SPF for notification emails. | |

**User's choice:** Cognito manages SES (Recommended)
**Notes:** No separate SES setup needed — Cognito handles it.

---

## Invitation Management UI

| Option | Description | Selected |
|--------|-------------|----------|
| Settings > Members tab | New tab in /app/settings alongside Roles. Members + pending invitations in one view. | ✓ |
| Dedicated members sub-page | Separate /app/settings/members page with more room. | |

**User's choice:** Settings > Members tab (Recommended)
**Notes:** Consistent with existing settings structure.

---

## Claude's Discretion

- Invitation Prisma model exact field types and indexes
- Members tab layout and component structure
- Invite dialog form validation UX
- First-login-after-invitation detection mechanism
- Notification email content for multi-org auto-join
- Error handling for AdminCreateUser failures
- Resend cooldown logic

## Deferred Ideas

- Custom SES email templates — using Cognito defaults for now
- Invitation analytics (INVT-08) — v3.x
- Bulk invitation management (INVT-07) — v3.x
- Resend (email provider) — explicitly rejected in favor of AWS SES via Cognito

---
phase: 16-user-invitations-onboarding-completion
plan: "02"
subsystem: invitations-ui
tags: [invitations, settings, members, ui, radix]
dependency_graph:
  requires: [16-01-invitation-backend]
  provides: [members-page, invite-dialog, invitations-table, members-table]
  affects: [settings-page]
tech_stack:
  added: []
  patterns: [settings-tab, data-table, dialog-form, cooldown-timer, alert-dialog-confirmation]
key_files:
  created:
    - web-ui/app/app/settings/members/page.tsx
    - web-ui/components/settings/invite-member-dialog.tsx
    - web-ui/components/settings/members-table.tsx
    - web-ui/components/settings/invitations-table.tsx
  modified:
    - web-ui/app/app/settings/page.tsx
decisions:
  - "Members tab added after Roles tab in settings page TabsList"
  - "Resend button uses 60-second cooldown with countdown tooltip"
  - "Revoke uses AlertDialog confirmation before executing"
  - "Empty states use Card components with copy from UI-SPEC"
metrics:
  duration_minutes: 6
  completed_date: "2026-04-01"
  tasks_completed: 2
  files_changed: 5
---

# Phase 16 Plan 02: Members UI Summary

**One-liner:** Settings Members tab with current members table, pending invitations table (resend cooldown + revoke confirmation), and invite dialog with email + role form — all wired to Plan 01's API routes.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Settings Members tab + Members page + invite dialog + tables | b29c401 | settings/page.tsx, members/page.tsx, invite-member-dialog.tsx, members-table.tsx, invitations-table.tsx |
| 2 | Visual verification (human checkpoint) | — | Approved by user |

## What Was Built

**Settings page tab** (`web-ui/app/app/settings/page.tsx`): Added "Members" tab trigger after "Roles" in the TabsList, linking to `/app/settings/members`.

**Members page** (`web-ui/app/app/settings/members/page.tsx`): Full page with "Team Members" section (MembersTable) and "Pending Invitations" section (InvitationsTable) separated by 48px gap. "Invite Member" button top-right opens the invite dialog. Fetches from `/api/settings/members` and `/api/invitations` on mount.

**Invite Member dialog** (`web-ui/components/settings/invite-member-dialog.tsx`): Dialog with email input + role dropdown. Zod validation. Role dropdown only shows roles at or below current user's level. "Don't invite" / "Send Invitation" buttons. POSTs to `/api/invitations`.

**Members table** (`web-ui/components/settings/members-table.tsx`): Displays current tenant members with name, email, role columns. Empty state: "No other members yet" Card.

**Invitations table** (`web-ui/components/settings/invitations-table.tsx`): Displays pending invitations with email, role, invited date, status columns. Resend button with 60-second cooldown and countdown tooltip. Revoke button with AlertDialog confirmation dialog. All copy matches UI-SPEC contract.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all components are fully implemented. API calls will fail without backend running, but that is expected behavior.

## Self-Check: PASSED

- `web-ui/app/app/settings/members/page.tsx` — FOUND
- `web-ui/components/settings/invite-member-dialog.tsx` — FOUND
- `web-ui/components/settings/members-table.tsx` — FOUND
- `web-ui/components/settings/invitations-table.tsx` — FOUND
- `web-ui/app/app/settings/page.tsx` contains "members" — FOUND
- Commit b29c401 — FOUND
- Human verification — APPROVED

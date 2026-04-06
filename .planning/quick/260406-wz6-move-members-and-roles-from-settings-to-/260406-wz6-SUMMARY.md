# Quick Task 260406-wz6 — Summary

**Task:** Move Members and Roles from Settings to dedicated Users & Permissions sidebar section
**Date:** 2026-04-06
**Commit:** 8a85bd5

## What Changed

### `web-ui/components/sidebar.tsx`
- Added collapsible "Users & Permissions" section between Audit Logs and Settings
- Section header uses `UserCog` icon with a `ChevronDown` toggle
- Two subsections:
  - **Users** → `/app/settings/members`
  - **Roles & Permissions** → `/app/settings/roles`
- Auto-expands when pathname matches either subsection route
- Collapsed sidebar: shows `UserCog` icon linking to `/app/settings/members`
- Settings nav item no longer activates on `/settings/members` or `/settings/roles`

### `web-ui/app/app/settings/page.tsx`
- Removed "Roles" and "Members" tabs from the Settings tab bar
- Removed unused `Users` import from lucide-react

## Result

The sidebar now has a dedicated "Users & Permissions" collapsible section. Settings is clean — only Appearance, Profile, Notifications, Security, and Organization tabs remain.

---
quick_task: 260406-rm8
status: complete
date: 2026-04-06
---

# Summary: Remove Old User Module

Deleted the Cognito-based user management module and redirected the sidebar to the RBAC members page.

## Changes

- Deleted `web-ui/app/app/admin/users/page.tsx` — old Cognito UserManagementPage
- Deleted `web-ui/app/app/admin/layout.tsx` — admin layout (only served the users page)
- Deleted `web-ui/app/api/admin/users/route.ts` — GET route calling Cognito ListUsersCommand
- Deleted `web-ui/app/api/admin/users/role/route.ts` — POST route for old role assignment
- Updated `web-ui/components/sidebar.tsx` — Users nav href changed from `/app/admin/users` to `/app/settings/members`

## Result

No Cognito user listing code remains. The sidebar Users link now points to the existing RBAC-based members page at `/app/settings/members`.

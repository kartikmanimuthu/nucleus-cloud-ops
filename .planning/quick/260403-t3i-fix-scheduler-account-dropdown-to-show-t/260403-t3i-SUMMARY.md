# 260403-t3i — Fix Scheduler Account Dropdown + Tenant Scoping

**Date:** 2026-04-03
**Status:** Complete

## What Was Fixed

Three root causes for "No account found" in the Create Schedule dropdown and cross-tenant data leakage:

1. `AccountDynamoRepository.getAccounts()` — queried GSI1 globally (`TYPE#ACCOUNT`), ignoring `tenantId`. Fixed by collecting raw DynamoDB items first, filtering `item.tenantId === tenantId` before transforming to `UIAccount`.

2. `ScheduleDynamoRepository.getSchedules()` — same pattern: `tenantId` was destructured from filters but never applied. Fixed with the same raw-item filter before transform.

3. `create-schedule-dialog.tsx` — used hardcoded `mockAccounts` array (3 fake entries), never called `/api/accounts`, and didn't include `accountId` in the create payload (causing 400 "Account ID is required"). Fixed by:
   - Fetching real accounts from `/api/accounts` on dialog open via `useEffect`
   - Replacing checkbox list with a `Select` dropdown
   - Adding `accountId` to form state and the `createSchedule` payload

4. `POST /api/schedules` route — spread `body` directly but the repository reads `schedule.accounts?.[0]`. Fixed by mapping `accounts: [body.accountId]` at the call site.

## Files Changed

- `web-ui/lib/db/repositories/account/dynamo.ts` — tenant filter on raw items before transform
- `web-ui/lib/db/repositories/schedule/dynamo.ts` — tenant filter on raw items before transform
- `web-ui/components/schedules/create-schedule-dialog.tsx` — real API fetch, Select dropdown, accountId in payload
- `web-ui/app/api/schedules/route.ts` — map `accountId` → `accounts` array for repository

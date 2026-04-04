# Quick Task 260403-u2f: Summary

**Date:** 2026-04-03
**Status:** Complete

## What Was Fixed

`POST /api/accounts/[accountId]/validate/route.ts` was calling `AccountService.validateAccount(accountId)` without `tenantId`. The service then passed `undefined` as `tenantId` to `updateAccount`, which uses a composite unique key `tenantId_accountId` in Prisma — causing `PrismaClientValidationError: Argument tenantId is missing`.

## Change

**File:** `web-ui/app/api/accounts/[accountId]/validate/route.ts`

- Added import: `getSessionTenantId` from `@/lib/auth-session`
- Added: `const tenantId = await getSessionTenantId();`
- Updated call: `AccountService.validateAccount(accountId, tenantId)`

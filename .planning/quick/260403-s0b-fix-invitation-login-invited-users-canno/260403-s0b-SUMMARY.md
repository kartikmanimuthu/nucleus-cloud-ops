# Quick Task 260403-s0b: Fix Invitation Login

**Date:** 2026-04-03
**Status:** Complete

## Problem

Invited users received a Cognito temp-password email but got 401 on login. The `CredentialsProvider` in `auth-options.ts` queries `prisma.authUser.findUnique({ where: { email } })` — but no `AuthUser` row existed for invited users because `invitation-service.ts` only called `AdminCreateUser` in Cognito without creating a PostgreSQL record.

## Fix

Modified `web-ui/lib/invitation-service.ts` D-04 branch (`createInvitation` for new users):

1. Generate a cryptographically random temp password via `crypto.randomBytes(9).toString("base64url")`
2. Hash it with bcrypt (12 rounds) and create an `AuthUser` row in PostgreSQL **before** the Cognito call
3. Pass `TemporaryPassword` to `AdminCreateUserCommand` so Cognito sends the same password in the email
4. Roll back the `AuthUser` row if the Cognito call throws

## Login flow after fix

1. Invitation created → `AuthUser` row exists with hashed temp password
2. Cognito sends email with the same temp password
3. User enters email + temp password at `/login`
4. `CredentialsProvider` finds `AuthUser`, `bcrypt.compare` succeeds → user returned
5. JWT callback fires `acceptPendingInvitation` → `UserTenantRole` created, invitation marked accepted
6. User lands in the app under the correct tenant

## Files Changed

- `web-ui/lib/invitation-service.ts` — D-04 branch: create `AuthUser` + pass `TemporaryPassword` to Cognito

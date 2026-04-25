# Inventory Discovery — Per-Account Sync (Sync Now)

**Date:** 2026-04-25  
**Status:** Approved  
**Branch:** infra-changes

---

## Problem

The existing "Sync Now" button triggers a full scan across all connected accounts for the tenant. With 104 accounts, users need the ability to sync a specific subset of accounts without waiting for a full scan.

---

## Goals

- Allow users to select one, many, or all accounts to sync from a searchable modal dialog
- Keep the interaction non-blocking (close modal + toast, same as today)
- Allow multiple per-account scans to run in parallel

---

## Non-Goals

- Real-time per-account progress tracking inside the modal
- Scheduling or recurring per-account sync (handled by discovery settings)
- Changes to the discovery worker scan logic

---

## Architecture

### Backend change — singleton key scoping

The pg-boss `discovery-scan` job uses a singleton key to prevent duplicate scans. Currently the key is `tenant:${tenantId}` for all scans, which blocks any concurrent scan for the same tenant.

**Change:** When `accountId` is present in the job payload, use `tenant:${tenantId}:account:${accountId}` as the singleton key. This allows multiple per-account scans to run in parallel without blocking each other.

"Sync All" (no `accountId`) keeps the existing key `tenant:${tenantId}`.

**File:** `web-ui/app/api/inventory/sync/route.ts`

```ts
const singletonKey = accountId
  ? `tenant:${tenantId}:account:${accountId}`
  : `tenant:${tenantId}`;
```

No changes to the worker (`workers/src/jobs/discovery/index.ts`) — it already filters by `accountId` when present.

---

## New Component: `SyncAccountsDialog`

**File:** `web-ui/components/inventory/sync-accounts-dialog.tsx`

### Props

```ts
interface SyncAccountsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSyncStarted: (count: number) => void; // triggers toast in parent
}
```

### Behavior

1. **Account list** — fetched on dialog open via `ClientAccountService.getAccounts({ statusFilter: 'active', connectionFilter: 'connected', limit: 1000 })`. Same call the inventory page already makes for the filter dropdown; no new API needed.

2. **Search** — client-side filter on account name or account ID (case-insensitive substring match).

3. **Select All / Deselect All** — toggle at the top of the list. "Select All" is the default state when the dialog opens.

4. **Row content** — each row shows:
   - Checkbox
   - Account name
   - Account ID (subdued)
   - Connection status badge (green "connected" / amber "error")
   - Last synced time ("synced 2h ago" / "never synced")

5. **Footer** — selected count label + Cancel button + "Sync Selected" button (disabled when 0 accounts selected).

6. **Submit** — when "Sync Selected" is clicked:
   - If all accounts are selected → one `POST /api/inventory/sync` with no `accountId` (existing behavior)
   - If a subset is selected → one `POST /api/inventory/sync` per selected account, fired in parallel via `Promise.all`
   - On success: dialog closes, parent calls `onSyncStarted(count)` which shows the existing toast: "Sync started for N accounts. Running in background."
   - On error: toast with error message, dialog stays open

---

## Inventory Page Changes

**File:** `web-ui/app/app/inventory/page.tsx`

- Replace the existing `handleSync()` call on the "Sync Now" button with opening `SyncAccountsDialog`
- Add `syncDialogOpen` state
- Pass `accounts` (already fetched for the filter dropdown) into the dialog to avoid a second fetch
- Update toast message to reflect account count: `"Sync started for N account(s)"`

---

## Data Flow

```
User clicks "Sync Now"
    ↓
SyncAccountsDialog opens (accounts pre-loaded from page state)
    ↓
User searches / selects accounts → clicks "Sync Selected"
    ↓
If all selected:
  POST /api/inventory/sync  (no accountId, singleton: tenant:${tenantId})
If subset selected:
  Promise.all([
    POST /api/inventory/sync { accountId: "111..." }  → singleton: tenant:${tenantId}:account:111...
    POST /api/inventory/sync { accountId: "222..." }  → singleton: tenant:${tenantId}:account:222...
    ...
  ])
    ↓
pg-boss enqueues discovery-scan jobs (parallel, non-blocking)
    ↓
Dialog closes → toast: "Sync started for N accounts"
    ↓
Workers pick up jobs, scan in parallel
    ↓
Page auto-refreshes status via existing GET /api/inventory/status polling
```

---

## Error Handling

- If one or more `POST /api/inventory/sync` calls fail (e.g. account already scanning), show a toast: "Sync started for X of Y accounts. N already in progress."
- Network errors show a generic error toast; dialog stays open so user can retry.

---

## Files Changed

| File | Change |
|------|--------|
| `web-ui/app/api/inventory/sync/route.ts` | Scope singleton key by accountId when present |
| `web-ui/components/inventory/sync-accounts-dialog.tsx` | New component |
| `web-ui/app/app/inventory/page.tsx` | Wire up dialog, update Sync Now button |

---

## Out of Scope

- `web-ui/app/api/discovery/execute/route.ts` — separate route used by agent ops; not changed
- Worker code — no changes needed
- Discovery settings page — no changes needed

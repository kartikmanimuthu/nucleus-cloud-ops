# Inventory Discovery — Per-Account Sync (Sync Now) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single "Sync Now" button with a searchable multi-select modal that lets users trigger discovery scans for one, many, or all of their 104 accounts.

**Architecture:** One new component (`SyncAccountsDialog`) receives the already-loaded accounts list from the inventory page, renders a searchable checkbox list, and fires parallel `POST /api/inventory/sync` calls on submit. The only backend change is scoping the pg-boss singleton key by `accountId` so per-account jobs can run in parallel.

**Tech Stack:** Next.js 15, React 19, Radix UI Dialog + Checkbox, Tailwind CSS, Vitest, `sonner` toasts, pg-boss

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `web-ui/app/api/inventory/sync/route.ts` | Modify | Scope singleton key by accountId |
| `web-ui/app/api/inventory/sync/sync-route.test.ts` | Create | Unit tests for singleton key logic |
| `web-ui/components/inventory/sync-accounts-dialog.tsx` | Create | Searchable multi-select sync modal |
| `web-ui/app/app/inventory/page.tsx` | Modify | Wire dialog, replace handleSync button |

---

## Task 1: Scope singleton key by accountId in sync route

**Files:**
- Modify: `web-ui/app/api/inventory/sync/route.ts:54-59`
- Create: `web-ui/app/api/inventory/sync/sync-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web-ui/app/api/inventory/sync/sync-route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
        })),
    },
}));

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn().mockResolvedValue('tenant-abc'),
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logResourceAction: vi.fn().mockResolvedValue(undefined) },
}));

const mockSend = vi.fn().mockResolvedValue('job-123');
vi.mock('@/lib/boss-client', () => ({
    getBoss: vi.fn().mockResolvedValue({ send: mockSend }),
}));

import { POST } from './route';

const makeRequest = (body: unknown) =>
    ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/inventory/sync', () => {
    beforeEach(() => { mockSend.mockClear(); });

    it('uses tenant-scoped singleton key when no accountId', async () => {
        await POST(makeRequest({}));
        const [, , opts] = mockSend.mock.calls[0];
        expect(opts.singletonKey).toBe('tenant:tenant-abc');
    });

    it('uses account-scoped singleton key when accountId provided', async () => {
        await POST(makeRequest({ accountId: 'acc-111' }));
        const [, , opts] = mockSend.mock.calls[0];
        expect(opts.singletonKey).toBe('tenant:tenant-abc:account:acc-111');
    });

    it('returns 200 with jobId and scanId on success', async () => {
        const res = await POST(makeRequest({ accountId: 'acc-111' }));
        expect(res._status).toBe(200);
        expect(res._data.success).toBe(true);
        expect(res._data.jobId).toBe('job-123');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web-ui && npx vitest run app/api/inventory/sync/sync-route.test.ts
```

Expected: FAIL — `tenant:tenant-abc` assertion fails (current code always uses `tenant:${tenantId}`)

- [ ] **Step 3: Update the singleton key logic in the route**

In `web-ui/app/api/inventory/sync/route.ts`, replace lines 54–59:

```typescript
        const boss = await getBoss();
        const jobId = await boss.send(
            'discovery-scan',
            {
                type: 'scan' as const,
                tenantId,
                accountId,
                triggeredBy: 'web-ui' as const,
                userEmail,
            },
            {
                singletonKey: accountId
                    ? `tenant:${tenantId}:account:${accountId}`
                    : `tenant:${tenantId}`,
                retryLimit: 2,
                retryDelay: 60,
                retryBackoff: true,
            }
        );
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd web-ui && npx vitest run app/api/inventory/sync/sync-route.test.ts
```

Expected: PASS — all 3 tests green

- [ ] **Step 5: Commit**

```bash
git add web-ui/app/api/inventory/sync/route.ts web-ui/app/api/inventory/sync/sync-route.test.ts
git commit -m "feat(inventory): scope discovery singleton key by accountId for parallel scans"
```

---

## Task 2: Build SyncAccountsDialog component

**Files:**
- Create: `web-ui/components/inventory/sync-accounts-dialog.tsx`

- [ ] **Step 1: Create the component**

Create `web-ui/components/inventory/sync-accounts-dialog.tsx`:

```typescript
"use client";

import { useState, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { UIAccount } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";

interface SyncAccountsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    accounts: UIAccount[];
    onSyncStarted: (count: number) => void;
}

export function SyncAccountsDialog({ open, onOpenChange, accounts, onSyncStarted }: SyncAccountsDialogProps) {
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set(accounts.map(a => a.accountId)));
    const [syncing, setSyncing] = useState(false);

    const filtered = useMemo(() => {
        const q = search.toLowerCase();
        if (!q) return accounts;
        return accounts.filter(a =>
            a.name.toLowerCase().includes(q) || a.accountId.toLowerCase().includes(q)
        );
    }, [accounts, search]);

    const allFilteredSelected = filtered.length > 0 && filtered.every(a => selected.has(a.accountId));

    const toggleAccount = (accountId: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(accountId)) next.delete(accountId);
            else next.add(accountId);
            return next;
        });
    };

    const toggleAll = () => {
        if (allFilteredSelected) {
            setSelected(prev => {
                const next = new Set(prev);
                filtered.forEach(a => next.delete(a.accountId));
                return next;
            });
        } else {
            setSelected(prev => {
                const next = new Set(prev);
                filtered.forEach(a => next.add(a.accountId));
                return next;
            });
        }
    };

    const handleSync = async () => {
        if (selected.size === 0) return;
        setSyncing(true);

        try {
            const isAll = selected.size === accounts.length;

            if (isAll) {
                const res = await fetch("/api/inventory/sync", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({}),
                });
                if (!res.ok) {
                    const data = await res.json();
                    throw new Error(data.error || "Failed to trigger sync");
                }
            } else {
                const results = await Promise.allSettled(
                    Array.from(selected).map(accountId =>
                        fetch("/api/inventory/sync", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ accountId }),
                        })
                    )
                );
                const failed = results.filter(r => r.status === "rejected").length;
                if (failed > 0) {
                    toast.warning(`Sync started for ${selected.size - failed} of ${selected.size} accounts. ${failed} already in progress.`);
                    onOpenChange(false);
                    onSyncStarted(selected.size - failed);
                    return;
                }
            }

            onOpenChange(false);
            onSyncStarted(selected.size);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to trigger sync");
        } finally {
            setSyncing(false);
        }
    };

    const handleOpenChange = (val: boolean) => {
        if (!syncing) {
            if (val) setSelected(new Set(accounts.map(a => a.accountId)));
            onOpenChange(val);
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <RefreshCw className="h-4 w-4" />
                        Sync Accounts
                    </DialogTitle>
                </DialogHeader>

                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search accounts..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="pl-9"
                    />
                </div>

                <div className="border rounded-md overflow-hidden">
                    {/* Select All row */}
                    <div
                        className="flex items-center gap-3 px-3 py-2 border-b bg-muted/30 cursor-pointer hover:bg-muted/50"
                        onClick={toggleAll}
                    >
                        <Checkbox
                            checked={allFilteredSelected}
                            onCheckedChange={toggleAll}
                            onClick={e => e.stopPropagation()}
                        />
                        <span className="text-sm font-medium text-primary">
                            {search ? `Select all matching (${filtered.length})` : `Select All (${accounts.length})`}
                        </span>
                    </div>

                    {/* Account list */}
                    <div className="max-h-72 overflow-y-auto divide-y">
                        {filtered.length === 0 ? (
                            <div className="px-3 py-4 text-sm text-muted-foreground text-center">No accounts match</div>
                        ) : (
                            filtered.map(account => (
                                <div
                                    key={account.accountId}
                                    className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/30"
                                    onClick={() => toggleAccount(account.accountId)}
                                >
                                    <Checkbox
                                        checked={selected.has(account.accountId)}
                                        onCheckedChange={() => toggleAccount(account.accountId)}
                                        onClick={e => e.stopPropagation()}
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-sm font-medium truncate">{account.name}</span>
                                            <Badge
                                                variant={account.connectionStatus === "connected" ? "default" : "destructive"}
                                                className="text-xs shrink-0"
                                            >
                                                {account.connectionStatus ?? "unknown"}
                                            </Badge>
                                        </div>
                                        <div className="flex items-center justify-between gap-2 mt-0.5">
                                            <span className="text-xs text-muted-foreground">{account.accountId}</span>
                                            <span className="text-xs text-muted-foreground shrink-0">
                                                {account.lastValidated
                                                    ? `synced ${formatDistanceToNow(new Date(account.lastValidated), { addSuffix: true })}`
                                                    : "never synced"}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                <DialogFooter className="flex items-center justify-between sm:justify-between">
                    <span className="text-sm text-muted-foreground">{selected.size} selected</span>
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={syncing}>
                            Cancel
                        </Button>
                        <Button onClick={handleSync} disabled={syncing || selected.size === 0}>
                            {syncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                            Sync Selected
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
```

- [ ] **Step 2: Install date-fns if not present**

```bash
cd web-ui && node -e "require('date-fns')" 2>/dev/null && echo "present" || npm install date-fns
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd web-ui && npx tsc --noEmit 2>&1 | grep sync-accounts-dialog
```

Expected: no output (no errors)

- [ ] **Step 4: Commit**

```bash
git add web-ui/components/inventory/sync-accounts-dialog.tsx
git commit -m "feat(inventory): add SyncAccountsDialog with search and multi-select"
```

---

## Task 3: Wire SyncAccountsDialog into the inventory page

**Files:**
- Modify: `web-ui/app/app/inventory/page.tsx`

- [ ] **Step 1: Add import and state**

At the top of `web-ui/app/app/inventory/page.tsx`, add the import after the existing inventory component imports (around line 16):

```typescript
import { SyncAccountsDialog } from "@/components/inventory/sync-accounts-dialog";
```

Inside `InventoryPage()`, after the `askAIOpen` state (around line 69), add:

```typescript
    const [syncDialogOpen, setSyncDialogOpen] = useState(false);
```

- [ ] **Step 2: Add the dialog component to the JSX**

After the `<AskAIDialog ... />` element near the bottom of the return statement, add:

```typescript
            <SyncAccountsDialog
                open={syncDialogOpen}
                onOpenChange={setSyncDialogOpen}
                accounts={accounts}
                onSyncStarted={(count) => {
                    toast.success(
                        count === 1
                            ? "Sync started for 1 account. It may take a few minutes to complete."
                            : `Sync started for ${count} accounts. It may take a few minutes to complete.`,
                        { duration: 5000 }
                    );
                    fetchSyncStatus();
                }}
            />
```

- [ ] **Step 3: Replace the Sync Now button**

Replace the existing Sync Now button (around line 298):

```typescript
                        <Button onClick={handleSync} disabled={syncing}>
                            {syncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                            Sync Now
                        </Button>
```

With:

```typescript
                        <Button onClick={() => setSyncDialogOpen(true)}>
                            <RefreshCw className="h-4 w-4 mr-2" />
                            Sync Now
                        </Button>
```

- [ ] **Step 4: Remove the now-unused handleSync function and syncing state**

Remove the `handleSync` function (lines 167–191) and the `const [syncing, setSyncing] = useState(false);` line (line 53).

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd web-ui && npx tsc --noEmit 2>&1 | grep -E "inventory/page|sync-accounts"
```

Expected: no output

- [ ] **Step 6: Run the full test suite**

```bash
cd web-ui && npx vitest run
```

Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add web-ui/app/app/inventory/page.tsx
git commit -m "feat(inventory): wire SyncAccountsDialog to Sync Now button"
```

---

## Task 4: Manual smoke test

- [ ] **Step 1: Start the dev server**

```bash
# Run this yourself in a terminal:
cd web-ui && npm run dev
```

- [ ] **Step 2: Open the inventory page**

Navigate to `http://localhost:3000/app/inventory`

- [ ] **Step 3: Verify the dialog opens**

Click "Sync Now" — the `SyncAccountsDialog` should open with all accounts pre-selected and a search input at the top.

- [ ] **Step 4: Verify search filters the list**

Type part of an account name or ID — the list should filter in real time.

- [ ] **Step 5: Verify partial selection**

Deselect a few accounts, click "Sync Selected" — toast should say "Sync started for N accounts."

- [ ] **Step 6: Verify Sync All**

Re-open, leave all selected, click "Sync Selected" — a single job fires (check network tab: one POST with no `accountId`).

- [ ] **Step 7: Verify already-in-progress handling**

Trigger a sync, then immediately open the dialog and sync the same account again — toast should say "N already in progress."

# Plan: Shared Chat History Across All Users (AIOps Module)

## Context
Currently, each user only sees their own chat threads in the AIOps sidebar (threads are stored in DynamoDB with `userId` as the partition key). The user wants a temporary shared view where all users can see and open any other user's chat history — useful for team collaboration on AIOps investigations without requiring per-user auth scoping.

## Approach
1. Modify the threads list API to scan all users' sessions (not just the current user's)
2. Return `ownerUserId` with each thread so the history endpoint can look up the correct DynamoDB partition
3. Thread history fetch accepts `?ownerUserId=` to read from the correct partition
4. UI: sidebar shows all users' threads with owner attribution; tabs and ChatInterface receive ownerUserId to fetch correct history
5. New messages written by any user to a shared thread go to their own session copy (write isolation preserved; read is shared)

---

## Files to Modify

### 1. `web-ui/app/api/threads/route.ts`
**Change GET**: Replace `chatHistory.listSessions(userId, 100)` with a raw DynamoDB `scan` across ALL partitions, filtering `itemType = 'metadata'`. Return threads sorted by `updatedAt` desc, limit 200. Include `ownerUserId` field in each result.

```typescript
// DynamoDB scan for all session metadata items
const result = await ddbDoc.scan({
    TableName: process.env.DYNAMODB_CHAT_HISTORY_TABLE,
    FilterExpression: 'itemType = :it',
    ExpressionAttributeValues: { ':it': 'metadata' },
});
// Map items: { id: item.sessionId, title, createdAt, updatedAt, ownerUserId: item.userId }
// Sort by updatedAt desc, slice to 200
```

File fallback (`threadStore.listThreads()`) already returns all threads — no change needed there.

---

### 2. `web-ui/app/api/threads/[threadId]/history/route.ts`
**Change GET**: Accept `?ownerUserId=` query param. If provided, use it as the userId for DynamoDB lookup instead of the session user.

```typescript
const url = new URL(_req.url);
const ownerUserId = url.searchParams.get('ownerUserId');
const userId = ownerUserId ?? (await getSessionUserId());
// rest of history fetch unchanged
```

Auth still required (must be logged in), but can read any user's thread.

---

### 3. `web-ui/components/agent/chat-tab-bar.tsx`
**Change `ChatTab` interface**: Add `ownerUserId?: string`.
**Change `onThreadSelect` prop**: Update signature to `(threadId: string, ownerUserId?: string) => void`.

---

### 4. `web-ui/app/agent/page.tsx`
**`handleThreadSelect`**: Add `ownerUserId?: string` param. Store `ownerUserId` in the tab object.
**`ChatInterface` render**: Pass `ownerUserId={tab.ownerUserId}` prop.

```typescript
const handleThreadSelect = useCallback((threadId: string, ownerUserId?: string) => {
    // existing tab lookup logic...
    const tab: ChatTab = { ...makeTab(threadId), title: 'Loading...', ownerUserId };
    // ...
}, [activeTabId]);
```

---

### 5. `web-ui/components/agent/thread-sidebar.tsx`
**`Thread` interface**: Add `ownerUserId?: string`.
**`onThreadSelect` prop**: Update to `(threadId: string, ownerUserId?: string) => void`.
**Thread item click**: Call `onThreadSelect(thread.id, thread.ownerUserId)`.
**UI**: Add a small owner badge (last 6 chars of ownerUserId or "You") next to each thread that belongs to another user, using a subtle muted style.

```tsx
{thread.ownerUserId && thread.ownerUserId !== currentUserId && (
    <span className="text-[9px] font-mono text-muted-foreground/60 truncate max-w-[60px]">
        {thread.ownerUserId.slice(-6)}
    </span>
)}
```

Need to expose current user's ID — fetch it once on mount via a lightweight `/api/auth/session` call (already available via NextAuth).

---

### 6. `web-ui/components/agent/chat-interface.tsx`
**Props**: Add `ownerUserId?: string` to `ChatInterfaceProps`.
**`fetchHistory`**: Append `?ownerUserId=...` if prop is set.

```typescript
const historyUrl = ownerUserId
    ? `/api/threads/${threadId}/history?ownerUserId=${encodeURIComponent(ownerUserId)}`
    : `/api/threads/${threadId}/history`;
const res = await fetch(historyUrl);
```

---

## Verification

1. **Local dev (no DynamoDB)**: File fallback path already returns all threads; checkpoint lookup is userId-agnostic — shared view works out of the box.
2. **With DynamoDB**: Open two browser sessions as different users → both see each other's threads in the sidebar. User B can open User A's thread and see full history.
3. **New messages**: User B sending in User A's thread writes to User B's own partition (no cross-contamination of original history).
4. **Delete**: Only visible in the dropdown; only deletes from the owner's partition (current user). Other users' threads can't be deleted by non-owners (server uses `getSessionUserId()` for DELETE, unchanged).
5. **TypeScript**: Run `cd web-ui && npm run build` — no type errors.
6. **Lint**: Run `cd web-ui && npm run lint` — no ESLint errors.

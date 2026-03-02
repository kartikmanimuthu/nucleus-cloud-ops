# Fix Chat Loading Spinner — Reliable Agent Execution Tracking

## Context

The loading spinner disappears during gaps between LangGraph node transitions (planning → execution → reflection → revision → final). Two root causes:

1. **Backend emits spurious `{ type: 'finish' }` per-phase** (line 491 in `route.ts`) — the AI SDK interprets this as "message complete", setting `isLoading=false` mid-execution
2. **Frontend uses a 2-second timeout** to detect streaming end (`isStreaming` state) — unreliable during long model thinking or tool execution gaps

Result: spinner vanishes, user can type/send during active processing, causing duplicate execution attempts (blocked by the thread lock, but confusing UX).

## Changes

### 1. Backend: Remove spurious lifecycle events (`route.ts`)

**File**: `web-ui/app/api/chat/route.ts`

Remove the per-phase `start`/`finish` emissions that incorrectly signal message completion:

- **Line 436**: Remove `safeEnqueue({ type: "start" } as any)` inside `on_chat_model_start`
- **Line 491**: Remove `safeEnqueue({ type: "finish" } as any)` inside `on_chat_model_end`

Keep the true stream-level `start` (line 412) and `finish` (line 575) — these correctly mark the overall execution boundary.

### 2. Backend: Add SSE heartbeat to prevent connection timeout (`route.ts`)

Inside `processStream`, after the initial `{ type: 'start' }` event, add a 15-second interval that emits `{ type: 'start-step' }` keepalive events. This prevents browser/proxy/ALB idle timeouts (typically 30-60s) during long tool executions or model thinking.

```
// Add after line 412 (initial start event)
const HEARTBEAT_INTERVAL_MS = 15_000;
const heartbeatInterval = setInterval(() => {
    if (!safeEnqueue({ type: 'start-step' })) {
        clearInterval(heartbeatInterval);
    }
}, HEARTBEAT_INTERVAL_MS);
```

Clear in the `finally` block:
```
clearInterval(heartbeatInterval);
```

### 3. Frontend: Replace timeout-based `isStreaming` with `isLoading` (`chat-interface.tsx`)

**File**: `web-ui/components/agent/chat-interface.tsx`

**Remove** (no longer needed once `isLoading` is reliable):
- `isStreaming` state (line 412)
- `streamTimeoutRef` ref (line 414)
- `lastMessageContentRef` ref (line 415)
- `isStreamingRef` ref (line 419)
- `isStreamingRef` sync effect (lines 614-617)
- Streaming detection effect (lines 619-653)
- Timeout cleanup effect (lines 656-662)

**Replace** all `isLoading || isStreaming` with `isLoading`:
- `handleEnhancePrompt` guard (line 712)
- `isActivelyStreaming` prop on MessageRow (line 1209)
- Loading spinner condition (line 1216)
- Stopped indicator condition (line 1231)
- Enhance button disabled (line 1739)
- Send/stop button type (line 1754)
- Send/stop button onClick (line 1755)
- Send/stop button disabled (line 1756)
- Send/stop button styling (line 1760)
- Send/stop button content (line 1765)

**Update `handleStop`** (line 783): Remove `setIsStreaming(false)` and `streamTimeoutRef` cleanup. Keep `stop()`, `setWasStopped(true)`.

### 4. Frontend: Add phase-aware loading text (optional enhancement)

Derive current agent phase from the last message's reasoning parts to show contextual status ("Planning...", "Executing...", "Reflecting...") instead of generic "Processing...":

```tsx
const currentPhase = useMemo(() => {
    if (!isLoading || messages.length === 0) return null;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== 'assistant') return null;
    const parts = lastMsg.parts || [];
    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if (part.type === 'reasoning' && typeof part.text === 'string') {
            if (part.text.includes('PLANNING_PHASE_START')) return 'Planning';
            if (part.text.includes('EXECUTION_PHASE_START')) return 'Executing';
            if (part.text.includes('REFLECTION_PHASE_START')) return 'Reflecting';
            if (part.text.includes('REVISION_PHASE_START')) return 'Revising';
            if (part.text.includes('FINAL_PHASE_START')) return 'Finalizing';
        }
    }
    return 'Processing';
}, [isLoading, messages]);
```

Update loading indicator text to use `{currentPhase || 'Processing'}...`.

## Files Modified

| File | Change |
|------|--------|
| `web-ui/app/api/chat/route.ts` | Remove spurious start/finish events (lines 436, 491); add heartbeat interval |
| `web-ui/components/agent/chat-interface.tsx` | Remove `isStreaming` + timeout mechanism; replace with `isLoading`; add phase indicator |

No changes to `planning-agent.ts`, `agent-shared.ts`, or `fast-agent.ts`.

## Edge Cases

- **Stop button**: `stop()` aborts the fetch → server's `req.signal` fires → heartbeat cleared in `finally` → `isLoading` goes false naturally
- **Errors**: `onError` fires → `isLoading` false → error state shown
- **HITL approval**: Stream ends with true `finish` → `isLoading` false → approval buttons shown → new POST on approve → `isLoading` true again
- **`maxSteps` retries**: `activeThreads` lock prevents duplicate execution; `isLoading` managed by SDK across retries

## Verification

1. `cd web-ui && npm run build` — confirm no TypeScript errors
2. `npm run dev` — test with a multi-step agent task (e.g., "Review EC2 instances across accounts")
3. Verify: spinner appears immediately on submit and stays visible through all phases
4. Verify: spinner shows phase-aware text ("Planning...", "Executing...", etc.)
5. Verify: stop button works and shows "Execution stopped" message
6. Verify: new messages can be sent after completion (spinner gone, input enabled)

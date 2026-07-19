"use client";

// Chat wiring extracted from components/agent/chat-interface.tsx (the
// Mission Control monolith). This is a MOVE, not a rewrite: chat-interface.tsx
// keeps its own internal copy of this same wiring, untouched, until it is
// deleted in Task 14 — this hook is the sanctioned temporary duplication.
// Source-mapped line ranges below refer to chat-interface.tsx as of this
// extraction (see task-9-report.md for the full table).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type ChatStatus } from "ai";
import { toast } from "sonner";
import { useRunState } from "@/components/agent/chat/use-run-state";
import { computeToolPartVisibility } from "@/components/agent/chat/run-state";
import type { RunState } from "@/components/agent/chat/run-state";
import { useDecisions, type Decision, type DecisionMap } from "@/components/agent/chat/use-decisions";
import { extractServerErrorMessage } from "@/lib/agent-chat/use-chat-session-helpers";

export interface UseChatSessionOptions {
  threadId: string;
  ownerUserId?: string;
  /**
   * Builds the per-request body payload (threadId, model, mode, accounts,
   * selectedSkill, mcpServerIds, knowledgeBaseIds, ...). This hook stays
   * agnostic of chat-configuration state — the caller owns it and hands back
   * a fresh snapshot on every call. Passed to DefaultChatTransport directly
   * (it's a `Resolvable<object>`), so it is re-invoked by the SDK at the time
   * of each actual HTTP request — no need to thread body overrides through
   * every sendMessage() call.
   */
  body: () => Record<string, unknown>;
}

export interface UseChatSessionResult {
  messages: any[];
  sendMessage: (message: {
    role: "user";
    content?: string;
    /** v7 UIMessages render from parts — callers must include a text part for
     *  the bubble; `content` rides along for the /api/chat server contract. */
    parts?: Array<Record<string, unknown>>;
    experimental_attachments?: Array<{ name: string; contentType: string; url: string }>;
  }) => Promise<void>;
  stop: () => void;
  status: ChatStatus;
  error: string | null;
  runState: RunState;
  decisions: DecisionMap;
  decide: (toolCallId: string, decision: Decision) => void;
  submitClarification: (toolCallId: string, answer: string) => void;
  toolVisibility: Map<string, string>;
  isStreaming: boolean;
  // Extras beyond the minimal brief-listed shape — both are load-bearing for
  // parity with chat-interface.tsx's rendering (ApprovalBatchCard's "decide
  // remaining" bulk action, and the legacy per-tool Confirmation fallback for
  // pre-Mission-Control parked threads). See task-9-report.md for rationale.
  decideRemaining: (approved: boolean) => void;
  handleToolApproval: (toolCallId: string, approved: boolean, toolName: string) => Promise<void>;
  isLoadingHistory: boolean;
  /**
   * Reset this session's in-memory conversation (transcript, restored
   * interrupt parts, and recorded decisions) — mirrors the monolith's
   * `handleClear` (setMessages([]) + reset local run-state). Does NOT delete
   * server-side history; a subsequent send starts the thread fresh.
   */
  clear: () => void;
}

export function useChatSession(opts: UseChatSessionOptions): UseChatSessionResult {
  const { threadId, ownerUserId, body } = opts;

  // Set once the user sends a message so a slow history fetch can't clobber
  // the optimistic conversation with a stale (or empty) server snapshot.
  // (chat-interface.tsx L674, there named `skipHistoryRef`.)
  const skipHistoryRef = useRef(false);
  // ai@7.0.22's Chat.makeRequest catches HTTP errors internally, routes them
  // to `onError` below, and RESOLVES the sendMessage promise — it never
  // rejects. submitDecisions can't rely on try/catch to detect a failed
  // resume; it reads this flag (set in onError, cleared right before each
  // sendMessage call). (L675-682)
  const submitErrorRef = useRef(false);
  const submitErrorMessageRef = useRef<string | null>(null);

  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [restoredParts, setRestoredParts] = useState<any[]>([]);
  const [decidedToolCalls, setDecidedToolCalls] = useState<
    Map<string, { approved: boolean; answer?: string }>
  >(new Map());

  // ── useChat + transport (L811-854) ────────────────────────────────────────
  const {
    messages,
    sendMessage: rawSendMessage,
    status,
    error: rawError,
    setMessages,
    addToolResult,
    stop,
  } = useChat({
    id: threadId,
    // Batch micro-delta SSE chunks into 50ms windows, reducing ~4000+ renders
    // → ~80-100. Without this, every 1-8 byte token fires a full React
    // reconciliation cycle.
    experimental_throttle: 500,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body,
    }),
    onError: (err) => {
      // The SDK swallows HTTP errors here and resolves sendMessage — this
      // flag is the only way submitDecisions can observe that its resume
      // failed. Keep the actual server error text so the failure toast can
      // say WHY.
      submitErrorRef.current = true;
      submitErrorMessageRef.current = extractServerErrorMessage(err);
    },
  }) as any;

  const isStreaming = status === "submitted" || status === "streaming";
  const error = useMemo(() => extractServerErrorMessage(rawError), [rawError]);

  // ── Mission Control run state (L858-997) ──────────────────────────────────
  // Restored pending-interrupt parts from a reload are appended as a
  // synthetic assistant message so deriveRunState sees them like live stream
  // parts.
  const runMessages = useMemo(
    () =>
      restoredParts.length > 0
        ? [...messages, { role: "assistant", parts: restoredParts, id: "restored-interrupt" }]
        : messages,
    [messages, restoredParts],
  );

  const decidedIdSet = useMemo(() => new Set(decidedToolCalls.keys()), [decidedToolCalls]);
  const runStateRaw = useRunState(runMessages, decidedIdSet);
  const pendingIds = useMemo(
    () => [
      ...(runStateRaw.pendingApproval?.tools.map((t) => t.toolCallId) ?? []),
      ...runStateRaw.pendingClarifications.map((c) => c.toolCallId),
    ],
    [runStateRaw.pendingApproval, runStateRaw.pendingClarifications],
  );

  // Resume a run by submitting the decided approval/clarification batch.
  // CARRIER MESSAGE: the /api/chat resume path branches on `body.decisions`
  // BEFORE reading the last message, so the message itself carries no
  // content — v7 `sendMessage` accepts an empty-content message, so we send
  // `content: ""` and the caller hides the resulting empty user bubble via
  // isEmptyDecisionCarrier(). (L888-953)
  const submitDecisions = useCallback(
    async (
      decisionBatch: Array<{ toolCallId: string; approved: boolean; reason?: string; answer?: string }>,
    ) => {
      setDecidedToolCalls((prev) => {
        const next = new Map(prev);
        for (const d of decisionBatch) next.set(d.toolCallId, { approved: d.approved, answer: d.answer });
        return next;
      });
      submitErrorRef.current = false;
      submitErrorMessageRef.current = null;
      await rawSendMessage(
        { role: "user", content: "" } as any, // carrier; server acts on body.decisions
        { body: { decisions: decisionBatch } },
      );
      if (submitErrorRef.current) {
        toast.error("Couldn't submit your decisions", {
          description: submitErrorMessageRef.current || "The run may be busy — try again.",
        });
        // Roll back the recorded decisions — decidedToolCalls feeds the
        // pending-state derivation, so leaving them in would drop the batch
        // from the cards and make retry impossible.
        setDecidedToolCalls((prev) => {
          const next = new Map(prev);
          for (const d of decisionBatch) next.delete(d.toolCallId);
          return next;
        });
        decisionsResetRef.current?.();
      } else {
        // Only clear the restored card once the submission actually
        // succeeded — clearing it eagerly meant a failed submit left no way
        // to retry.
        setRestoredParts([]);
      }
    },
    [rawSendMessage],
  );

  const { decisions, decide, decideRemaining, resolvedIds, reset: resetDecisions } = useDecisions({
    pendingToolCallIds: pendingIds,
    onComplete: submitDecisions,
  });
  // submitDecisions is defined above useDecisions but needs to call reset()
  // on failure — a ref sidesteps the circular dependency without reordering
  // hooks.
  const decisionsResetRef = useRef<(() => void) | null>(null);
  decisionsResetRef.current = resetDecisions;

  const mergedResolvedIds = useMemo(() => {
    if (decidedIdSet.size === 0) return resolvedIds;
    const merged = new Set(resolvedIds);
    for (const id of decidedIdSet) merged.add(id);
    return merged;
  }, [resolvedIds, decidedIdSet]);
  const runState = useRunState(runMessages, mergedResolvedIds);

  // ClarificationCard's onAnswer wiring, lifted verbatim (L1962).
  const submitClarification = useCallback(
    (toolCallId: string, answer: string) => decide(toolCallId, { approved: true, answer }),
    [decide],
  );

  // Cross-message tool-card dedupe: after an approval resume the server
  // re-emits tool parts under their original tool_call_ids in a NEW
  // assistant message. Keyed off the live (raw) messages array. (L997)
  const toolVisibility = useMemo(() => computeToolPartVisibility(messages), [messages]);

  // Local reset (monolith handleClear parity, L1143-1147). A send has NOT
  // taken over the thread here, so skipHistoryRef is intentionally left as-is:
  // clearing is a user action on the current thread, not a thread switch.
  const clear = useCallback(() => {
    setMessages([]);
    setRestoredParts([]);
    setDecidedToolCalls(new Map());
  }, [setMessages]);

  // ── History fetch + restore (L1053-1125) ──────────────────────────────────
  // Guarded so a stale load (thread switch / unmount) or a send that races
  // the fetch cannot setState late or clobber the optimistic conversation.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function fetchHistory() {
      setIsLoadingHistory(true);
      setRestoredParts([]);

      try {
        const historyUrl = ownerUserId
          ? `/api/threads/${threadId}/history?ownerUserId=${encodeURIComponent(ownerUserId)}`
          : `/api/threads/${threadId}/history`;
        const res = await fetch(historyUrl, { signal: controller.signal });
        // Bail if this load is no longer current, or a send has already
        // populated the conversation for this thread.
        if (cancelled || skipHistoryRef.current) return;
        if (res.ok) {
          const data = await res.json();
          if (cancelled || skipHistoryRef.current) return;
          if (data.messages && data.messages.length > 0) {
            // Task 4's history route already returns typed parts (data-phase,
            // data-memory, tool-invocation, text) — pass them through as-is,
            // no client-side legacy/sentinel reconstruction needed here.
            setMessages(data.messages);
          }

          // Mission Control: restore live run-state from the history response
          // so a reload mid-run shows the plan / parked approval card again.
          // `plan` and `pendingInterrupt` are separate top-level fields on the
          // response (extractThreadRunState), not pre-built data parts, so
          // they're wrapped into typed parts here — this is NOT legacy-format
          // parsing, `pendingInterrupt.parts` are already typed data parts
          // straight from the server.
          if (data.pendingInterrupt?.parts?.length) {
            // A parked plan-mode run carries BOTH a plan and a pending
            // interrupt — prepend the plan part so the plan rail survives the
            // reload, not just the approval/clarification card.
            setRestoredParts([
              ...(data.plan?.length ? [{ type: "data-plan", data: { steps: data.plan, updatedBy: "history" } }] : []),
              ...data.pendingInterrupt.parts,
            ]);
          } else if (data.plan?.length) {
            // Reloaded threads carry the final plan even without live
            // data-plan parts.
            setRestoredParts([{ type: "data-plan", data: { steps: data.plan, updatedBy: "history" } }]);
          }
        } else {
          console.warn("[useChatSession] Failed to fetch history:", res.status);
        }
      } catch (err) {
        if ((err as any)?.name === "AbortError") return;
        console.error("[useChatSession] Error fetching history:", err);
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    }

    fetchHistory();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, ownerUserId, setMessages]);

  // ── Send / resume (L1252-1343) ────────────────────────────────────────────
  const sendMessage = useCallback(
    async (message: {
      role: "user";
      content?: string;
      parts?: Array<Record<string, unknown>>;
      experimental_attachments?: Array<{ name: string; contentType: string; url: string }>;
    }) => {
      // Stale restored run-state must not override the new run ("last part
      // wins").
      setRestoredParts([]);
      // A send has taken over this thread — an in-flight history load must
      // not overwrite the optimistic user message / streamed response.
      skipHistoryRef.current = true;
      await rawSendMessage(message as any);
    },
    [rawSendMessage],
  );

  // Handle tool approval - makes explicit API call to resume LangGraph
  // execution. LEGACY resume contract: only reachable via the inline
  // per-tool Confirmation, which itself only renders when a pending tool
  // call isn't owned by the batch/clarification cards (i.e. old parked
  // threads without typed data parts). Current runs resolve approvals
  // through `decide` (batch decision). (L1297-1343)
  const handleToolApproval = useCallback(
    async (toolCallId: string, approved: boolean, toolName: string) => {
      setRestoredParts([]); // Stale restored run-state must not override the new run.

      // First, update local state via addToolResult (for UI feedback). AI SDK
      // v5 expects { tool, toolCallId, output } — passing the legacy `result`
      // key left the tool output undefined so the approve/reject state wasn't
      // reflected until the follow-up re-stream.
      const result = approved ? "Approved" : "Cancelled by user";
      addToolResult({ tool: toolName, toolCallId, output: result });

      // Then, make explicit API call to resume the graph. We send the tool
      // result as a message with role: 'tool'.
      await rawSendMessage({
        role: "tool" as any,
        content: result,
        toolCallId,
      } as any);
    },
    [addToolResult, rawSendMessage],
  );

  return {
    messages,
    sendMessage,
    stop,
    status,
    error,
    runState,
    decisions,
    decide,
    submitClarification,
    toolVisibility,
    isStreaming,
    decideRemaining,
    handleToolApproval,
    isLoadingHistory,
    clear,
  };
}

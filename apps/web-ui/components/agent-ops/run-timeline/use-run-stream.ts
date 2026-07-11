"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queries/query-keys";
import type { RunDetail } from "@/lib/queries/agent-ops";
import type { AgentOpsEvent, AgentOpsRun } from "@/lib/agent-ops/types";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAX_BACKOFF_MS = 30_000;

/** Pure cache merge: append an event unless its SK is already present. */
export function appendEvent(old: RunDetail | undefined, ev: AgentOpsEvent): RunDetail | undefined {
  if (!old) return undefined;
  if (old.events.some(e => e.SK === ev.SK)) return old;
  return { ...old, events: [...old.events, ev] };
}

function safeParse<T>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/**
 * Live-stream run events into the TanStack Query cache while the run is active.
 * Returns { streaming } so the caller can enable polling fallback when false.
 */
export function useRunStream(runId: string, active: boolean): { streaming: boolean } {
  const qc = useQueryClient();
  const [streaming, setStreaming] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    if (!active || !runId) return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const detailKey = queryKeys.agentOps.detail(runId);

    const open = () => {
      es = new EventSource(`/api/agent-ops/${runId}/stream`);
      es.onopen = () => { retryRef.current = 0; setStreaming(true); };
      es.addEventListener("run-event", (e) => {
        const ev = safeParse<AgentOpsEvent>((e as MessageEvent).data);
        if (ev) qc.setQueryData<RunDetail>(detailKey, (old) => appendEvent(old, ev));
      });
      es.addEventListener("status", (e) => {
        const run = safeParse<AgentOpsRun>((e as MessageEvent).data);
        if (!run) return;
        qc.setQueryData<RunDetail>(detailKey, (old) => (old ? { ...old, run } : old));
        if (TERMINAL.has(run.status)) {
          stopped = true;
          es?.close();
          setStreaming(false);
          // One authoritative refetch after settle (catches any missed frame).
          qc.invalidateQueries({ queryKey: detailKey });
          qc.invalidateQueries({ queryKey: queryKeys.agentOps.lists() });
        }
      });
      es.onerror = () => {
        es?.close();
        setStreaming(false);
        if (!stopped) {
          retryRef.current += 1;
          const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** retryRef.current);
          timer = setTimeout(open, delay);
        }
      };
    };

    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
      setStreaming(false);
    };
  }, [runId, active, qc]);

  return { streaming };
}

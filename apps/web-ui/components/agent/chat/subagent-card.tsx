'use client';

import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useSubagentRuns } from '@/lib/queries/subagents';
import type { SubagentState } from './run-state';

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** An abort surfaced as a failure — the run was stopped; the sub-agent did nothing wrong. */
function isAbortSummary(summary: string | undefined): boolean {
  return !!summary && /abort/i.test(summary);
}

const STATUS_ICON = {
  running: <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />,
  done: <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />,
  failed: <XCircle className="h-3.5 w-3.5 text-destructive" />,
} as const;

/** Ticks once a second while `active`, so the elapsed label counts up live. */
function useNowWhile(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [active]);
  return now;
}

export function SubagentCard({
  subagent,
  threadId,
}: {
  subagent: SubagentState;
  /** Thread whose persisted sub-agent runs hold the transcript. Optional: without
   *  it the card still renders the live task + findings, just no transcript. */
  threadId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = subagent.status === 'running';
  const canExpand = !isRunning && !!subagent.summary;
  const now = useNowWhile(isRunning && !!subagent.startedAt);
  const cancelled = subagent.status === 'failed' && isAbortSummary(subagent.summary);

  // Loaded only on expand — the transcript is never streamed (three interleaved
  // sub-agent narrations are unreadable) and never persisted in the message
  // history, so it comes from agent_subagent_runs on demand. Keyed per thread, so
  // expanding a second card in the same thread is served from cache.
  const { data: runs } = useSubagentRuns(threadId, expanded);
  const transcript = runs?.find(r => r.subagentId === subagent.id)?.transcript ?? [];

  return (
    <div className="rounded-md border bg-muted/30 text-sm">
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left',
          canExpand ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default',
        )}
        onClick={() => canExpand && setExpanded(v => !v)}
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
      >
        {canExpand
          ? (expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />)
          : <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}

        {STATUS_ICON[subagent.status]}

        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium" title={subagent.role}>{subagent.role}</span>
          {/* Task excerpt — disambiguates cards whose role strings collide. */}
          <span className="block truncate text-xs text-muted-foreground" title={subagent.task}>
            {subagent.task}
          </span>
        </span>

        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {subagent.toolCount} tools · {formatTokens(subagent.tokensIn + subagent.tokensOut)} tokens
          {isRunning && subagent.startedAt ? ` · ${formatElapsed(now - subagent.startedAt)}` : ''}
        </span>
      </button>

      {/* Live action line — what makes the spinner trustworthy. */}
      {isRunning && subagent.lastTool && (
        <div
          className="truncate border-t px-3 py-1 text-xs text-muted-foreground"
          data-testid="subagent-current-tool"
        >
          › {subagent.lastTool}
        </div>
      )}

      {cancelled && !expanded && (
        <div className="border-t px-3 py-1 text-xs text-muted-foreground">
          Cancelled — the run was stopped before this sub-agent finished.
        </div>
      )}

      {expanded && subagent.summary && (
        <div className="border-t px-3 py-2">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Task</p>
          <p className="mb-3 whitespace-pre-wrap text-xs text-muted-foreground">{subagent.task}</p>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Findings</p>
          <p className="whitespace-pre-wrap text-xs">
            {cancelled
              ? 'Cancelled — the run was stopped before this sub-agent finished.'
              : subagent.summary}
          </p>

          {transcript.length > 0 && (
            <div className="mt-3 border-t pt-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Transcript</p>
              <div className="space-y-1.5">
                {transcript.map((entry, i) => (
                  <div key={i} className="text-xs">
                    <span className="text-muted-foreground">
                      {entry.kind === 'tool' ? `${entry.name ?? 'tool'} → ` : 'thinking: '}
                    </span>
                    <span className="whitespace-pre-wrap">{entry.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

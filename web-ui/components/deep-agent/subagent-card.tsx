'use client';

import React, { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  Brain, Zap, Terminal, ChevronDown, ChevronRight,
  Loader2, CheckCircle2, AlertCircle, Clock, Wrench,
} from 'lucide-react';
import type { SubagentEvent, SubagentToolItem } from '@/lib/deep-agent/types';

const SUBAGENT_META: Record<string, { color: string; icon: typeof Brain; label: string }> = {
  'aws-ops':  { color: 'amber',  icon: Zap,      label: 'AWS Operations' },
  'research': { color: 'violet', icon: Brain,    label: 'Research'       },
  'code-iac': { color: 'cyan',   icon: Terminal, label: 'Code & IaC'     },
};

const STATUS_CFG = {
  pending:  { icon: Clock,        badge: 'bg-muted text-muted-foreground border-border',                                        label: 'Pending'  },
  running:  { icon: Loader2,      badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',         label: 'Running'  },
  complete: { icon: CheckCircle2, badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',     label: 'Complete' },
  error:    { icon: AlertCircle,  badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',                 label: 'Error'    },
};

// ---------------------------------------------------------------------------
// SubagentToolRow — a single tool call made within a subagent
// ---------------------------------------------------------------------------

function SubagentToolRow({ tool }: { tool: SubagentToolItem }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-border/60 bg-background/60 overflow-hidden text-xs">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/50 transition-colors"
      >
        <Wrench className="w-3 h-3 text-muted-foreground shrink-0" />
        <span className="font-mono font-medium text-foreground flex-1 truncate">{tool.toolName}</span>
        <span className="text-[10px] text-muted-foreground shrink-0">
          {new Date(tool.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
        {open
          ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
          : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
        }
      </button>
      {open && tool.result && (
        <div className="border-t border-border/40 p-2.5">
          <pre className="text-[11px] text-foreground/80 bg-muted/50 rounded-md p-2 overflow-x-auto max-h-40 whitespace-pre-wrap break-words leading-relaxed">
            {tool.result}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SubagentCard
// ---------------------------------------------------------------------------

interface SubagentCardProps { event: SubagentEvent; }

export function SubagentCard({ event }: SubagentCardProps) {
  const [open, setOpen] = useState(event.status === 'running');
  const deltaRef = useRef<HTMLDivElement>(null);

  // Auto-open when tools or delta text start arriving
  useEffect(() => {
    if ((event.tools?.length ?? 0) > 0 || event.deltaText) {
      setOpen(true);
    }
  }, [event.tools?.length, event.deltaText]);

  // Auto-scroll delta text to bottom as it streams
  useEffect(() => {
    if (deltaRef.current) {
      deltaRef.current.scrollTop = deltaRef.current.scrollHeight;
    }
  }, [event.deltaText]);

  const meta = SUBAGENT_META[event.name] ?? { color: 'slate', icon: Brain, label: event.name };
  const sc = STATUS_CFG[event.status as keyof typeof STATUS_CFG] ?? STATUS_CFG.pending;
  const StatusIcon = sc.icon;
  const AgentIcon  = meta.icon;

  const toolCount = event.tools?.length ?? 0;

  const borderCls = {
    amber:  'border-amber-500/25 bg-amber-500/5',
    violet: 'border-violet-500/25 bg-violet-500/5',
    cyan:   'border-cyan-500/25 bg-cyan-500/5',
    slate:  'border-border bg-muted/50',
  }[meta.color] ?? 'border-border bg-muted/50';

  const iconCls = {
    amber:  'bg-amber-500/15 text-amber-500',
    violet: 'bg-violet-500/15 text-violet-500',
    cyan:   'bg-cyan-500/15 text-cyan-500',
    slate:  'bg-muted text-muted-foreground',
  }[meta.color] ?? 'bg-muted text-muted-foreground';

  const labelCls = {
    amber:  'text-amber-600 dark:text-amber-400',
    violet: 'text-violet-600 dark:text-violet-400',
    cyan:   'text-cyan-600 dark:text-cyan-400',
    slate:  'text-foreground',
  }[meta.color] ?? 'text-foreground';

  return (
    <div className={cn('rounded-xl border overflow-hidden transition-all', borderCls)}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        <div className={cn('w-6 h-6 rounded-md flex items-center justify-center shrink-0', iconCls)}>
          <AgentIcon className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn('text-xs font-semibold', labelCls)}>{meta.label}</span>
            <span className={cn('flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border font-medium', sc.badge)}>
              <StatusIcon className={cn('w-2.5 h-2.5', event.status === 'running' && 'animate-spin')} />
              {sc.label}
            </span>
            {toolCount > 0 && (
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border font-medium bg-muted text-muted-foreground border-border">
                <Wrench className="w-2.5 h-2.5" />
                {toolCount} tool{toolCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {event.description && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">{event.description}</p>
          )}
        </div>
        {open
          ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        }
      </button>

      {open && (
        <div className="border-t border-border/50 p-4 space-y-3">
          {/* Live streaming delta text — shown only while running */}
          {event.deltaText && event.status === 'running' && (
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold mb-2">Thinking</p>
              <div
                ref={deltaRef}
                className="text-xs text-foreground/80 bg-muted/50 border border-border/50 rounded-lg p-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed font-mono"
              >
                {event.deltaText}
                <span className="inline-block w-1.5 h-3 bg-violet-400 ml-0.5 animate-pulse align-text-bottom" />
              </div>
            </div>
          )}

          {/* Tool call log */}
          {toolCount > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold mb-2">
                Tool Calls ({toolCount})
              </p>
              <div className="space-y-1">
                {event.tools!.map((t, i) => (
                  <SubagentToolRow key={i} tool={t} />
                ))}
              </div>
            </div>
          )}

          {/* Final result */}
          {event.result && (
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold mb-2">Result</p>
              <pre className="text-xs text-foreground bg-muted border border-border rounded-xl p-3 overflow-x-auto max-h-52 whitespace-pre-wrap break-words leading-relaxed">
                {event.result}
              </pre>
            </div>
          )}

          {/* Error */}
          {event.error && (
            <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg p-3">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {event.error}
            </div>
          )}

          {/* Timing metadata */}
          {event.startedAt && (
            <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
              <span>Started: {new Date(event.startedAt).toLocaleTimeString()}</span>
              {event.completedAt && (
                <span>Duration: {((new Date(event.completedAt).getTime() - new Date(event.startedAt).getTime()) / 1000).toFixed(1)}s</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

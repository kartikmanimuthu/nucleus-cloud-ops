'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  Brain, Zap, Terminal, ChevronDown, ChevronRight,
  Loader2, CheckCircle2, AlertCircle, Clock,
} from 'lucide-react';
import type { SubagentEvent } from '@/lib/deep-agent/types';

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

interface SubagentCardProps { event: SubagentEvent; }

export function SubagentCard({ event }: SubagentCardProps) {
  const [open, setOpen] = useState(event.status === 'running');

  const meta = SUBAGENT_META[event.name] ?? { color: 'slate', icon: Brain, label: event.name };
  const sc = STATUS_CFG[event.status as keyof typeof STATUS_CFG] ?? STATUS_CFG.pending;
  const StatusIcon = sc.icon;
  const AgentIcon  = meta.icon;

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
          {event.result && (
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold mb-2">Result</p>
              <pre className="text-xs text-foreground bg-muted border border-border rounded-xl p-3 overflow-x-auto max-h-52 whitespace-pre-wrap break-words leading-relaxed">
                {event.result}
              </pre>
            </div>
          )}
          {event.error && (
            <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg p-3">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {event.error}
            </div>
          )}
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

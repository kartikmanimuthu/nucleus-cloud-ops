'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  Shield, CheckCircle2, XCircle, Edit3,
  ChevronDown, ChevronRight, Terminal,
} from 'lucide-react';
import type {
  PendingApproval, ApprovalDecision, ApprovalDecisionType,
} from '@/lib/deep-agent/types';

interface ApprovalDialogProps {
  approval: PendingApproval;
  onDecide: (decisions: ApprovalDecision[]) => void;
}

export function ApprovalDialog({ approval, onDecide }: ApprovalDialogProps) {
  const { actionRequests, reviewConfigs } = approval;

  const configMap = Object.fromEntries(
    (reviewConfigs ?? []).map(cfg => [cfg.actionName, cfg]),
  );

  const [decisions, setDecisions] = useState<Record<string, ApprovalDecision>>(
    Object.fromEntries(actionRequests.map(req => [req.name, { type: 'approve' }])),
  );
  const [editedArgs, setEditedArgs] = useState<Record<string, string>>(
    Object.fromEntries(
      actionRequests.map(req => [req.name, JSON.stringify(req.args, null, 2)]),
    ),
  );
  const [expandedTool, setExpandedTool] = useState<string | null>(
    actionRequests[0]?.name ?? null,
  );

  function setDecision(toolName: string, type: ApprovalDecisionType) {
    setDecisions(prev => ({
      ...prev,
      [toolName]: {
        type,
        ...(type === 'edit' ? { args: tryParseJson(editedArgs[toolName]) } : {}),
      },
    }));
  }

  function handleArgChange(toolName: string, value: string) {
    setEditedArgs(prev => ({ ...prev, [toolName]: value }));
    if (decisions[toolName]?.type === 'edit') {
      setDecisions(prev => ({
        ...prev,
        [toolName]: { type: 'edit', args: tryParseJson(value) },
      }));
    }
  }

  function approveAll() {
    const all = Object.fromEntries(actionRequests.map(req => [req.name, { type: 'approve' as const }]));
    setDecisions(all);
    onDecide(actionRequests.map(() => ({ type: 'approve' as const })));
  }

  function rejectAll() {
    const all = Object.fromEntries(actionRequests.map(req => [req.name, { type: 'reject' as const }]));
    setDecisions(all);
    onDecide(actionRequests.map(() => ({ type: 'reject' as const })));
  }

  function submit() {
    const decisionList = actionRequests.map(req => {
      const d = decisions[req.name];
      if (d.type === 'edit') return { type: 'edit' as const, args: tryParseJson(editedArgs[req.name]) };
      return d;
    });
    onDecide(decisionList);
  }

  return (
    <div className="mx-auto max-w-2xl w-full">
      <div className="bg-card border border-amber-500/30 rounded-2xl overflow-hidden shadow-xl shadow-amber-500/10">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 bg-amber-500/10 border-b border-amber-500/20">
          <div className="w-8 h-8 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
            <Shield className="w-4 h-4 text-amber-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-amber-600 dark:text-amber-400">Human Approval Required</h3>
            <p className="text-xs text-amber-600/70 dark:text-amber-400/70">
              {actionRequests.length} action{actionRequests.length > 1 ? 's' : ''} pending approval
            </p>
          </div>
        </div>

        {/* Action list */}
        <div className="p-4 space-y-3">
          {actionRequests.map((req, idx) => {
            const reviewConfig = configMap[req.name];
            const allowed = reviewConfig?.allowedDecisions ?? ['approve', 'edit', 'reject'];
            const currentDecision = decisions[req.name]?.type ?? 'approve';
            const isExpanded = expandedTool === req.name;

            const borderCls =
              currentDecision === 'approve' ? 'border-emerald-500/30' :
              currentDecision === 'reject'  ? 'border-rose-500/30' :
              currentDecision === 'edit'    ? 'border-blue-500/30' :
              'border-border';

            return (
              <div
                key={`${req.name}-${idx}`}
                className={cn('rounded-xl border overflow-hidden transition-all bg-muted/40', borderCls)}
              >
                <button
                  onClick={() => setExpandedTool(isExpanded ? null : req.name)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent transition-colors"
                >
                  <Terminal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm font-mono text-foreground flex-1">{req.name}</span>
                  {isExpanded
                    ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                    : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                  }
                </button>

                {isExpanded && (
                  <div className="border-t border-border p-4 space-y-4">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold mb-2">Arguments</p>
                      {currentDecision === 'edit' ? (
                        <textarea
                          value={editedArgs[req.name]}
                          onChange={e => handleArgChange(req.name, e.target.value)}
                          rows={6}
                          className="w-full bg-background border border-border rounded-lg p-3 text-xs font-mono text-foreground outline-none focus:border-blue-500/50 transition-colors resize-none"
                        />
                      ) : (
                        <pre className="text-xs text-foreground bg-background border border-border rounded-lg p-3 overflow-x-auto max-h-40 whitespace-pre-wrap break-words">
                          {JSON.stringify(req.args, null, 2)}
                        </pre>
                      )}
                    </div>

                    <div className="flex gap-2">
                      {(allowed as ApprovalDecisionType[]).includes('approve') && (
                        <button
                          onClick={() => setDecision(req.name, 'approve')}
                          className={cn(
                            'flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all flex-1 justify-center border',
                            currentDecision === 'approve'
                              ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 border-emerald-500/40'
                              : 'bg-muted text-muted-foreground border-border hover:border-emerald-500/35 hover:text-emerald-600 dark:hover:text-emerald-400',
                          )}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                        </button>
                      )}
                      {(allowed as ApprovalDecisionType[]).includes('edit') && (
                        <button
                          onClick={() => setDecision(req.name, 'edit')}
                          className={cn(
                            'flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all flex-1 justify-center border',
                            currentDecision === 'edit'
                              ? 'bg-blue-500/20 text-blue-600 dark:text-blue-300 border-blue-500/40'
                              : 'bg-muted text-muted-foreground border-border hover:border-blue-500/35 hover:text-blue-600 dark:hover:text-blue-400',
                          )}
                        >
                          <Edit3 className="w-3.5 h-3.5" /> Edit
                        </button>
                      )}
                      {(allowed as ApprovalDecisionType[]).includes('reject') && (
                        <button
                          onClick={() => setDecision(req.name, 'reject')}
                          className={cn(
                            'flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all flex-1 justify-center border',
                            currentDecision === 'reject'
                              ? 'bg-rose-500/20 text-rose-600 dark:text-rose-300 border-rose-500/40'
                              : 'bg-muted text-muted-foreground border-border hover:border-rose-500/35 hover:text-rose-600 dark:hover:text-rose-400',
                          )}
                        >
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-4 border-t border-border bg-muted/30">
          <button
            onClick={rejectAll}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 text-xs font-medium hover:bg-rose-500/20 transition-all"
          >
            <XCircle className="w-3.5 h-3.5" /> Reject All
          </button>
          <button
            onClick={approveAll}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 text-xs font-medium hover:bg-emerald-500/20 transition-all"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Approve All
          </button>
          <button
            onClick={submit}
            className="ml-auto px-5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white text-xs font-semibold hover:from-amber-400 hover:to-orange-400 transition-all shadow-lg shadow-amber-500/25 hover:shadow-amber-500/40"
          >
            Submit Decisions →
          </button>
        </div>
      </div>
    </div>
  );
}

function tryParseJson(value: string): Record<string, unknown> {
  try { return JSON.parse(value); } catch { return {}; }
}

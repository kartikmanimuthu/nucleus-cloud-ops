"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, ShieldCheck, X } from "lucide-react";
import type { PendingApprovalTool } from "./run-state";
import type { DecisionMap } from "./use-decisions";
import { GuardRiskPanel } from "./guard-risk-panel";

function ArgsPreview({ args }: { args: Record<string, unknown> }) {
  const text = JSON.stringify(args, null, 2);
  return (
    <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-snug">
      {text.length > 2000 ? text.slice(0, 2000) + "\n… (truncated)" : text}
    </pre>
  );
}

export function ApprovalBatchCard({
  tools,
  decisions,
  onDecide,
  onDecideRemaining,
}: {
  tools: PendingApprovalTool[];
  decisions: DecisionMap;
  onDecide: (toolCallId: string, d: { approved: boolean; reason?: string }) => void;
  onDecideRemaining: (approved: boolean) => void;
}) {
  const undecided = tools.filter((t) => decisions[t.toolCallId] === undefined);
  return (
    <div data-testid="approval-batch-card" className="my-2 overflow-hidden rounded-lg border border-amber-500/30 bg-background shadow-sm">
      <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4" />
        {tools.length} tool call{tools.length === 1 ? "" : "s"} awaiting your approval
      </div>

      <div className="divide-y">
        {tools.map((tool) => {
          const decision = decisions[tool.toolCallId];
          const mutative = !!tool.guard?.isMutative;
          return (
            <div key={tool.toolCallId} className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold">▸ {tool.toolName}</span>
                {!mutative && (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-600">
                    <ShieldCheck className="h-3 w-3" /> read-only
                  </span>
                )}
                <span className="ml-auto text-[11px]">
                  {decision === undefined ? (
                    <span className="text-amber-600">● awaiting</span>
                  ) : decision.approved ? (
                    <span className="text-emerald-600">✓ approved</span>
                  ) : (
                    <span className="text-red-600">✕ rejected</span>
                  )}
                </span>
              </div>
              <ArgsPreview args={tool.args} />
              {mutative && tool.guard && <GuardRiskPanel guard={tool.guard} />}
              {decision === undefined && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" className="h-7" onClick={() => onDecide(tool.toolCallId, { approved: true })}>
                    <Check className="mr-1 h-3 w-3" /> Approve
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 border-red-500/40 text-red-600 hover:bg-red-500/10"
                    onClick={() => onDecide(tool.toolCallId, { approved: false })}>
                    <X className="mr-1 h-3 w-3" /> Reject
                  </Button>
                  {tool.guard?.saferPath && (
                    <Button size="sm" variant="ghost" className="h-7"
                      onClick={() => onDecide(tool.toolCallId, { approved: false, reason: `Use safer path instead: ${tool.guard!.saferPath}` })}>
                      Use safer path
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={cn("flex items-center justify-between gap-2 border-t bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground")}>
        <span>Run continues when all are decided — approved calls run, rejected return "denied by user" to the agent.</span>
        {undecided.length > 0 && (
          <span className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => onDecideRemaining(true)}>
              ✓ Approve remaining
            </Button>
            <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => onDecideRemaining(false)}>
              ✕ Reject remaining
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}

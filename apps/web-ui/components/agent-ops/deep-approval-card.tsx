"use client";

import { useState } from "react";
import { Loader2, ShieldCheck, ShieldX, MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useSubmitDecisions } from "@/lib/queries/agent-ops";

export interface PendingActionView {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

type Verdict = { approved: boolean; reason?: string; answer?: string };

/**
 * A pending action counts as decided once it has a verdict — except `ask_user`
 * approved with no answer: the server (toResumeMap) rejects an approved
 * ask_user decision whose answer is empty, so the gate must not treat a
 * verdict object alone as sufficient there. Declining to answer (approved:
 * false) needs no answer and is decided as soon as it's set.
 */
function isDecided(action: PendingActionView, verdict: Verdict | undefined): boolean {
  if (!verdict) return false;
  if (action.toolName === "ask_user" && verdict.approved) {
    return !!verdict.answer?.trim();
  }
  return true;
}

/**
 * Per-action approval for a deep run. Every pending action needs a decision
 * before the run can resume — the API rejects a partial set — so the submit
 * button stays disabled until all of them are decided.
 */
export function DeepApprovalCard({
  runId,
  actions,
}: {
  runId: string;
  actions: PendingActionView[];
}) {
  const submit = useSubmitDecisions();
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});

  const set = (id: string, v: Verdict) => setVerdicts(prev => ({ ...prev, [id]: v }));
  const undecided = actions.filter(a => !isDecided(a, verdicts[a.toolCallId]));

  const decideAll = (approved: boolean) =>
    setVerdicts(Object.fromEntries(actions.map(a => [a.toolCallId, { approved }])));

  const onSubmit = () => {
    submit.mutate(
      { runId, decisions: actions.map(a => ({ toolCallId: a.toolCallId, ...verdicts[a.toolCallId] })) },
      {
        onSuccess: () => toast.success("Decisions submitted — run resuming"),
        onError: (err: Error) => toast.error(err.message),
      },
    );
  };

  return (
    <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-700 dark:bg-amber-950/20">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <ShieldCheck className="h-4 w-4" /> Approval required
        <Badge variant="outline" className="ml-auto border-amber-400 text-xs text-amber-600">
          {actions.length} action{actions.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="mb-3 space-y-2">
        {actions.map(action => {
          const verdict = verdicts[action.toolCallId];
          const decided = isDecided(action, verdict);
          const isQuestion = action.toolName === "ask_user";
          return (
            <div key={action.toolCallId} className="rounded-md border bg-background p-3">
              <div className="mb-2 flex items-center gap-2">
                {isQuestion && <MessageCircleQuestion className="size-4 shrink-0 text-primary" />}
                <code className="text-xs font-semibold">{action.toolName}</code>
                {decided && verdict && (
                  <Badge variant="outline" className={verdict.approved ? "border-green-400 text-xs text-green-600" : "border-red-400 text-xs text-red-600"}>
                    {verdict.approved ? (isQuestion ? "answered" : "approved") : "rejected"}
                  </Badge>
                )}
              </div>

              <pre className="mb-2 max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(action.args, null, 2)}
              </pre>

              {isQuestion ? (
                <div className="space-y-2">
                  <Textarea
                    placeholder="Your answer…"
                    className="text-sm"
                    value={verdict?.answer ?? ""}
                    onChange={e => set(action.toolCallId, { approved: true, answer: e.target.value })}
                  />
                  <Button size="sm" variant="outline" onClick={() => set(action.toolCallId, { approved: false })}>
                    Decline to answer
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="bg-green-600 text-white hover:bg-green-700"
                    onClick={() => set(action.toolCallId, { approved: true })}
                  >
                    <ShieldCheck className="mr-1.5 size-3.5" /> Approve
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => set(action.toolCallId, { approved: false })}>
                    <ShieldX className="mr-1.5 size-3.5" /> Reject
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => decideAll(true)}>Approve all</Button>
        <Button size="sm" variant="outline" onClick={() => decideAll(false)}>Reject all</Button>
        <Button
          className="ml-auto"
          disabled={undecided.length > 0 || submit.isPending}
          onClick={onSubmit}
        >
          {submit.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {undecided.length > 0 ? `${undecided.length} left to decide` : "Submit & resume"}
        </Button>
      </div>
    </div>
  );
}

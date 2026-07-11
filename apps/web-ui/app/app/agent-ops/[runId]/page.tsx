"use client"

import { useCallback, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { Spinner } from "@/components/ui/spinner"
import {
  ArrowLeft, CheckCircle2, Clock, Loader2, MessageSquare, ShieldCheck, ShieldX, XCircle,
} from "lucide-react"
import { RunHeader } from "@/components/agent-ops/run-timeline/run-header"
import { RunTimeline } from "@/components/agent-ops/run-timeline/timeline"
import { useRunStream } from "@/components/agent-ops/run-timeline/use-run-stream"
import { useAgentOpsRunDetail, useApproveRun, useCancelRun, useResumeRun } from "@/lib/queries/agent-ops"
import { exportRunToPdf } from "@/lib/agent-ops/export-pdf"
import { useTenant } from "@/lib/tenant-context"

const ACTIVE = new Set(["queued", "in_progress", "awaiting_input", "awaiting_approval"])

export default function RunDetailPage() {
  const params = useParams()
  const router = useRouter()
  const runId = params.runId as string
  const { timezone } = useTenant()

  const [exporting, setExporting] = useState(false)
  const [clarificationText, setClarificationText] = useState("")

  // First fetch without polling; useRunStream drives live updates, and we fall
  // back to 2s polling only while the run is active and the stream is down.
  const detail = useAgentOpsRunDetail(runId, { pollMs: undefined })
  const run = detail.data?.run
  const events = detail.data?.events ?? []
  const isActive = !!run && ACTIVE.has(run.status)

  const { streaming } = useRunStream(runId, isActive)

  // Polling fallback: a second subscription on the same query key contributes
  // an interval only when the run is active and the stream is down.
  useAgentOpsRunDetail(runId, { pollMs: isActive && !streaming ? 2000 : false })

  const cancelRun = useCancelRun()
  const approveRun = useApproveRun()
  const resumeRun = useResumeRun()

  const handleExportPdf = useCallback(async () => {
    if (!run) return
    setExporting(true)
    try { await exportRunToPdf(run, events) } finally { setExporting(false) }
  }, [run, events])

  if (detail.isLoading) {
    return <div className="flex flex-1 items-center justify-center py-24"><Spinner /></div>
  }

  if (!run) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-24 text-muted-foreground">
        <XCircle className="mb-3 h-12 w-12 opacity-30" />
        <p className="font-medium">Run not found</p>
        <Button variant="ghost" className="mt-3" onClick={() => router.push("/app/agent-ops")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to Agent Ops
        </Button>
      </div>
    )
  }

  const tokens = events.reduce(
    (acc, e) => {
      acc.input += (e.metadata?.inputTokens as number) || 0
      acc.output += (e.metadata?.outputTokens as number) || 0
      return acc
    },
    { input: 0, output: 0 },
  )

  return (
    <div className="space-y-5">
      <RunHeader
        run={run}
        tokens={tokens}
        streaming={streaming}
        onCancel={() => cancelRun.mutate({ runId, body: { tenantId: run.tenantId } })}
        cancelling={cancelRun.isPending}
        onExportPdf={handleExportPdf}
        exporting={exporting}
        onBack={() => router.push("/app/agent-ops")}
      />

      {/* Result */}
      {run.result?.summary && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4" /> Result
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md bg-muted p-4">
              <MarkdownContent content={run.result.summary} />
            </div>
            {run.result.toolsUsed?.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                <span className="mr-1 text-xs text-muted-foreground">Tools used:</span>
                {run.result.toolsUsed.map(tool => (
                  <Badge key={tool} variant="outline" className="text-xs">{tool}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {run.error && (
        <Card className="border-red-200 dark:border-red-800">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-red-600">
              <XCircle className="h-4 w-4" /> Error
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/30">{run.error}</pre>
          </CardContent>
        </Card>
      )}

      {/* Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4" /> Execution Timeline
            <Badge variant="secondary" className="ml-1 text-xs">{events.length} events</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RunTimeline
            events={events}
            runStatus={run.status}
            timezone={timezone}
            live={run.status === "in_progress" || run.status === "queued"}
          />

          {/* HIL: clarification — inline where the run paused */}
          {run.status === "awaiting_input" && run.clarification && (
            <div className="mt-4 rounded-lg border border-blue-300 bg-blue-50/50 p-4 dark:border-blue-700 dark:bg-blue-950/20">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-400">
                <MessageSquare className="h-4 w-4" /> The agent needs your input
                {run.clarification.missingInfo && (
                  <Badge variant="outline" className="ml-auto border-blue-400 text-xs text-blue-600">{run.clarification.missingInfo}</Badge>
                )}
              </p>
              <div className="mb-3 rounded-md border bg-background p-3">
                <MarkdownContent content={run.clarification.question} />
              </div>
              <Textarea
                placeholder="Type your response…"
                value={clarificationText}
                onChange={e => setClarificationText(e.target.value)}
                rows={3}
                disabled={resumeRun.isPending}
              />
              <Button
                className="mt-3"
                disabled={resumeRun.isPending || !clarificationText.trim()}
                onClick={() => resumeRun.mutate(
                  { runId, body: { tenantId: run.tenantId, userInput: clarificationText.trim() } },
                  { onSuccess: () => setClarificationText("") },
                )}
              >
                {resumeRun.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageSquare className="mr-2 h-4 w-4" />}
                Submit Response
              </Button>
            </div>
          )}

          {/* HIL: approval — inline where the run paused */}
          {run.status === "awaiting_approval" && run.approvalRequest && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-700 dark:bg-amber-950/20">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                <ShieldCheck className="h-4 w-4" /> Approval required
                <Badge variant="outline" className="ml-auto border-amber-400 text-xs text-amber-600">
                  {run.approvalRequest.approvalType === "plan" ? "Plan" : "Tool execution"}
                </Badge>
              </p>
              <div className="mb-3 rounded-md border bg-background p-3">
                <ol className="list-inside list-decimal space-y-1">
                  {run.approvalRequest.planSteps.map((step: string, i: number) => (
                    <li key={i} className="text-sm">{step}</li>
                  ))}
                </ol>
                {run.approvalRequest.pendingTools && run.approvalRequest.pendingTools.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <span className="mr-1 text-xs text-muted-foreground">Mutative tools:</span>
                    {run.approvalRequest.pendingTools.map((tool: string) => (
                      <Badge key={tool} variant="outline" className="border-red-300 text-xs text-red-600">{tool}</Badge>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-3">
                <Button
                  className="bg-green-600 text-white hover:bg-green-700"
                  disabled={approveRun.isPending}
                  onClick={() => approveRun.mutate({ runId, body: { tenantId: run.tenantId, action: "approve" } })}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" /> Approve & Execute
                </Button>
                <Button
                  variant="destructive"
                  disabled={approveRun.isPending}
                  onClick={() => approveRun.mutate({ runId, body: { tenantId: run.tenantId, action: "reject" } })}
                >
                  <ShieldX className="mr-2 h-4 w-4" /> Reject
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

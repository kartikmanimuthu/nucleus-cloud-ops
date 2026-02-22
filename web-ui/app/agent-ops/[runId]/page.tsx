"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams, useSearchParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
    ArrowLeft, Clock, CheckCircle2, XCircle, Loader2,
    MessageSquare, AlertCircle, Globe, Zap, Terminal, Brain, RefreshCw,
    Wrench, FileText, ChevronDown, ChevronUp, Cpu
} from "lucide-react"
import type { AgentOpsRun, AgentOpsEvent, AgentEventType } from "@/lib/agent-ops/types"

const EVENT_TYPE_CONFIG: Record<AgentEventType, { label: string; icon: typeof Brain; color: string; bg: string }> = {
    planning:    { label: "Planning",    icon: Brain,        color: "text-blue-500",   bg: "border-blue-400" },
    execution:   { label: "Execution",  icon: Terminal,     color: "text-green-500",  bg: "border-green-400" },
    tool_call:   { label: "Tool Call",  icon: Wrench,       color: "text-orange-500", bg: "border-orange-400" },
    tool_result: { label: "Tool Result",icon: FileText,     color: "text-teal-500",   bg: "border-teal-400" },
    reflection:  { label: "Reflection", icon: RefreshCw,    color: "text-purple-500", bg: "border-purple-400" },
    revision:    { label: "Revision",   icon: RefreshCw,    color: "text-indigo-500", bg: "border-indigo-400" },
    final:       { label: "Final",      icon: CheckCircle2, color: "text-green-600",  bg: "border-green-600" },
    error:       { label: "Error",      icon: XCircle,      color: "text-red-500",    bg: "border-red-400" },
}

// ─── Single event row ────────────────────────────────────────────────────────

function EventRow({ event, idx }: { event: AgentOpsEvent; idx: number }) {
    const [expanded, setExpanded] = useState(false)
    const config = EVENT_TYPE_CONFIG[event.eventType] || EVENT_TYPE_CONFIG.execution
    const EventIcon = config.icon

    const tokens = event.metadata
        ? ((event.metadata.inputTokens as number) || 0) + ((event.metadata.outputTokens as number) || 0)
        : 0

    const mainContent = event.content || event.toolOutput || ""
    const isLong = mainContent.length > 300
    const displayContent = isLong && !expanded ? mainContent.slice(0, 300) + "…" : mainContent

    return (
        <div key={idx} className="relative pl-10 py-3 first:pt-0">
            {/* Timeline dot */}
            <div className={`absolute left-2.5 top-3.5 w-3 h-3 rounded-full border-2 bg-background ${config.bg}`} />

            <div className="space-y-1.5">
                {/* Header row */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <EventIcon className={`h-3.5 w-3.5 shrink-0 ${config.color}`} />
                        <span className="text-xs font-semibold">{config.label}</span>
                        <span className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded">{event.node}</span>
                        {event.toolName && (
                            <Badge variant="outline" className="text-xs py-0 font-mono">{event.toolName}</Badge>
                        )}
                        {tokens > 0 && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Cpu className="h-3 w-3" />{tokens} tk
                            </span>
                        )}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                        {new Date(event.createdAt).toLocaleTimeString()}
                    </span>
                </div>

                {/* Tool arguments (for tool_call events) */}
                {event.toolArgs && Object.keys(event.toolArgs).length > 0 && (
                    <div className="rounded border border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/20 p-2">
                        <p className="text-xs text-muted-foreground mb-1 font-medium uppercase tracking-wide">Args</p>
                        <pre className="text-xs text-orange-800 dark:text-orange-300 whitespace-pre-wrap break-all">
                            {JSON.stringify(event.toolArgs, null, 2).slice(0, 2000)}
                        </pre>
                    </div>
                )}

                {/* Main content */}
                {displayContent && (
                    <div>
                        <pre className={`text-xs text-muted-foreground whitespace-pre-wrap break-all ${
                            event.eventType === "tool_result"
                                ? "bg-teal-50 dark:bg-teal-950/20 border border-teal-200 dark:border-teal-900 rounded p-2"
                                : event.eventType === "error"
                                ? "text-red-600 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded p-2"
                                : ""
                        }`}>
                            {displayContent}
                        </pre>
                        {isLong && (
                            <button
                                onClick={() => setExpanded(!expanded)}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1 transition-colors"
                            >
                                {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                {expanded ? "Show less" : `Show ${mainContent.length - 300} more chars`}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function RunDetailPage() {
    const params = useParams()
    const searchParams = useSearchParams()
    const router = useRouter()
    const runId = params.runId as string
    const tenantId = searchParams.get("tenantId") || "default"

    const [run, setRun] = useState<AgentOpsRun | null>(null)
    const [events, setEvents] = useState<AgentOpsEvent[]>([])
    const [loading, setLoading] = useState(true)

    const fetchDetail = useCallback(async () => {
        try {
            const res = await fetch(`/api/agent-ops/${runId}?tenantId=${tenantId}`)
            const data = await res.json()
            if (data.run) setRun(data.run)
            if (data.events) setEvents(data.events)
        } catch (error) {
            console.error("Failed to fetch run detail:", error)
        } finally {
            setLoading(false)
        }
    }, [runId, tenantId])

    useEffect(() => {
        fetchDetail()
        const interval = setInterval(() => {
            if (run?.status === "in_progress" || run?.status === "queued") {
                fetchDetail()
            }
        }, 5000)
        return () => clearInterval(interval)
    }, [fetchDetail, run?.status])

    const formatTime = (iso: string) =>
        new Date(iso).toLocaleString("en-US", {
            month: "short", day: "numeric", year: "numeric",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        })

    const formatDuration = (ms?: number) => {
        if (!ms) return "—"
        if (ms < 1000) return `${ms}ms`
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
        return `${(ms / 60000).toFixed(1)}m`
    }

    const tokenTotals = events.reduce(
        (acc, e) => {
            if (e.metadata) {
                acc.input += (e.metadata.inputTokens as number) || 0
                acc.output += (e.metadata.outputTokens as number) || 0
            }
            return acc
        },
        { input: 0, output: 0 }
    )

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        )
    }

    if (!run) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                <XCircle className="h-12 w-12 mb-3 opacity-30" />
                <p className="font-medium">Run not found</p>
                <Button variant="ghost" className="mt-3" onClick={() => router.push("/agent-ops")}>
                    <ArrowLeft className="h-4 w-4 mr-2" /> Back to Agent Ops
                </Button>
            </div>
        )
    }

    const SourceIcon = run.source === "slack" ? MessageSquare : run.source === "jira" ? AlertCircle : Globe

    return (
        <div className="flex-1 overflow-auto p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
                <Button variant="ghost" size="icon" onClick={() => router.push("/agent-ops")}>
                    <ArrowLeft className="h-4 w-4" />
                </Button>
                <div className="flex-1">
                    <h1 className="text-xl font-bold flex items-center gap-2">
                        <Zap className="h-5 w-5 text-yellow-500" />
                        Run Detail
                    </h1>
                    <p className="text-sm text-muted-foreground font-mono">{run.runId}</p>
                </div>
                <Badge
                    variant={
                        run.status === "completed" ? "secondary" :
                        run.status === "failed" ? "destructive" :
                        run.status === "in_progress" ? "default" : "outline"
                    }
                    className="text-sm px-3 py-1"
                >
                    {run.status === "in_progress" && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                    {run.status === "completed" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                    {run.status === "failed" && <XCircle className="h-3 w-3 mr-1" />}
                    {run.status.replace("_", " ").toUpperCase()}
                </Badge>
            </div>

            {/* Run metadata grid */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <Card>
                    <CardContent className="pt-4 pb-3 px-4">
                        <div className="text-xs text-muted-foreground mb-1">Source</div>
                        <div className="flex items-center gap-2">
                            <SourceIcon className="h-4 w-4" />
                            <span className="font-medium capitalize">{run.source}</span>
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-4 pb-3 px-4">
                        <div className="text-xs text-muted-foreground mb-1">Mode</div>
                        <div className="font-medium capitalize">{run.mode}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-4 pb-3 px-4">
                        <div className="text-xs text-muted-foreground mb-1">Started</div>
                        <div className="font-medium text-sm">{formatTime(run.createdAt)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-4 pb-3 px-4">
                        <div className="text-xs text-muted-foreground mb-1">Duration</div>
                        <div className="font-medium">{formatDuration(run.durationMs)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-4 pb-3 px-4">
                        <div className="text-xs text-muted-foreground mb-1">Tokens</div>
                        <div className="font-medium flex items-center gap-1">
                            <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                            {tokenTotals.input + tokenTotals.output > 0
                                ? `${tokenTotals.input}↑ ${tokenTotals.output}↓`
                                : "—"}
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Task Description */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Task Description</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm">{run.taskDescription}</p>
                    {run.selectedSkill && (
                        <div className="mt-2">
                            <Badge variant="outline" className="text-xs">Skill: {run.selectedSkill}</Badge>
                        </div>
                    )}
                    {run.accountName && (
                        <p className="text-xs text-muted-foreground mt-1">
                            Account: {run.accountName} ({run.accountId})
                        </p>
                    )}
                </CardContent>
            </Card>

            {/* Result */}
            {run.result?.summary && (
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-green-600 flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4" /> Result
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <pre className="text-sm whitespace-pre-wrap bg-muted p-3 rounded-md">{run.result.summary}</pre>
                        {run.result.toolsUsed && run.result.toolsUsed.length > 0 && (
                            <div className="flex gap-1.5 mt-3 flex-wrap">
                                <span className="text-xs text-muted-foreground mr-1">Tools used:</span>
                                {run.result.toolsUsed.map(tool => (
                                    <Badge key={tool} variant="outline" className="text-xs">{tool}</Badge>
                                ))}
                            </div>
                        )}
                        {run.result.iterations > 0 && (
                            <p className="text-xs text-muted-foreground mt-2">{run.result.iterations} iteration(s)</p>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* Error */}
            {run.error && (
                <Card className="border-red-200 dark:border-red-800">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-red-600 flex items-center gap-2">
                            <XCircle className="h-4 w-4" /> Error
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <pre className="text-sm whitespace-pre-wrap text-red-600 bg-red-50 dark:bg-red-950/30 p-3 rounded-md">
                            {run.error}
                        </pre>
                    </CardContent>
                </Card>
            )}

            {/* Execution Timeline */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                        <Clock className="h-4 w-4" />
                        Execution Timeline
                        <Badge variant="secondary" className="text-xs ml-1">{events.length} events</Badge>
                        {run.status === "in_progress" && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
                                <Loader2 className="h-3 w-3 animate-spin" /> Live
                            </span>
                        )}
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {events.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-4 text-center">
                            {run.status === "queued" ? "Waiting for agent to start…" : "No events recorded yet."}
                        </p>
                    ) : (
                        <div className="relative space-y-0">
                            <div className="absolute left-4 top-0 bottom-0 w-px bg-border" />
                            {events.map((event, idx) => (
                                <EventRow key={`${event.SK}-${idx}`} event={event} idx={idx} />
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

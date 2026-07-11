"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams, useSearchParams, useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
    ArrowLeft, CalendarClock, Play, Pause, Trash2, RefreshCw,
    CheckCircle2, XCircle, Loader2, Clock, AlertCircle,
    MessageSquare, Globe, StopCircle, ShieldCheck,
} from "lucide-react"
import type { ScheduledTask, AgentOpsRun, AgentOpsStatus } from "@/lib/agent-ops/types"
import { ScheduledTaskDialog } from "@/components/agent-ops/scheduled-task-dialog"
import { formatDateTime } from "@/lib/date-utils"
import { useTenant } from '@/lib/tenant-context'

const STATUS_CONFIG: Record<AgentOpsStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }> = {
    queued: { label: "Queued", variant: "outline", icon: Clock },
    in_progress: { label: "In Progress", variant: "default", icon: Loader2 },
    awaiting_input: { label: "Awaiting Input", variant: "outline", icon: AlertCircle },
    awaiting_approval: { label: "Awaiting Approval", variant: "outline", icon: ShieldCheck },
    completed: { label: "Completed", variant: "secondary", icon: CheckCircle2 },
    failed: { label: "Failed", variant: "destructive", icon: XCircle },
    cancelled: { label: "Cancelled", variant: "outline", icon: StopCircle },
}

export default function ScheduledTaskDetailPage() {
    const { taskId } = useParams<{ taskId: string }>()
    const searchParams = useSearchParams()
    const router = useRouter()
    const tenantId = searchParams.get("tenantId") || "default"
    const { timezone } = useTenant()

    const [task, setTask] = useState<ScheduledTask | null>(null)
    const [runs, setRuns] = useState<AgentOpsRun[]>([])
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)

    const fetchData = useCallback(async () => {
        setLoading(true)
        try {
            const [taskRes, runsRes] = await Promise.all([
                fetch(`/api/agent-ops/scheduled-tasks/${taskId}?tenantId=${tenantId}`),
                fetch(`/api/agent-ops/scheduled-tasks/${taskId}/runs?tenantId=${tenantId}&limit=50`),
            ])
            const [taskData, runsData] = await Promise.all([taskRes.json(), runsRes.json()])
            setTask(taskData.task || null)
            setRuns(runsData.runs || [])
        } catch (err) {
            console.error("Failed to fetch:", err)
        } finally {
            setLoading(false)
        }
    }, [taskId, tenantId])

    useEffect(() => { fetchData() }, [fetchData])

    const withBusy = async (fn: () => Promise<void>) => {
        setBusy(true)
        try { await fn() } finally { setBusy(false); await fetchData() }
    }

    const handlePause = () => withBusy(async () => {
        await fetch(`/api/agent-ops/scheduled-tasks/${taskId}/pause`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenantId }),
        })
    })

    const handleResume = () => withBusy(async () => {
        await fetch(`/api/agent-ops/scheduled-tasks/${taskId}/resume`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenantId }),
        })
    })

    const handleDelete = () => withBusy(async () => {
        if (!confirm(`Delete "${task?.name}"?`)) return
        await fetch(`/api/agent-ops/scheduled-tasks/${taskId}?tenantId=${tenantId}`, { method: "DELETE" })
        router.push(`/app/agent-ops/scheduled-tasks?tenantId=${tenantId}`)
    })

    const handleTrigger = () => withBusy(async () => {
        const res = await fetch(`/api/agent-ops/scheduled-tasks/${taskId}/trigger`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenantId }),
        })
        const data = await res.json()
        if (data.runId) router.push(`/app/agent-ops/${data.runId}?tenantId=${tenantId}`)
    })

    const formatTime = (iso?: string) => iso
        ? formatDateTime(iso, 'shortDateTime', timezone)
        : "—"

    const formatDuration = (ms?: number) => {
        if (!ms) return "—"
        if (ms < 1000) return `${ms}ms`
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
        return `${(ms / 60000).toFixed(1)}m`
    }

    if (loading) return (
        <div className="flex items-center justify-center h-64 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading...
        </div>
    )

    if (!task) return (
        <div className="p-6">
            <Button variant="ghost" onClick={() => router.back()}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
            <p className="mt-4 text-muted-foreground">Task not found.</p>
        </div>
    )

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Button variant="ghost" size="sm" onClick={() => router.push(`/app/agent-ops/scheduled-tasks?tenantId=${tenantId}`)}>
                        <ArrowLeft className="h-4 w-4 mr-1" /> Back
                    </Button>
                    <div>
                        <h1 className="text-xl font-bold flex items-center gap-2">
                            <CalendarClock className="h-5 w-5 text-blue-500" />
                            {task.name}
                        </h1>
                        <p className="text-muted-foreground text-sm mt-0.5">{task.description}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
                        <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleTrigger} disabled={busy}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Play className="h-4 w-4 mr-2" />}
                        Run Now
                    </Button>
                    {task.taskStatus === "active"
                        ? <Button variant="outline" size="sm" onClick={handlePause} disabled={busy}>
                            <Pause className="h-4 w-4 mr-2" /> Pause
                        </Button>
                        : <Button variant="outline" size="sm" onClick={handleResume} disabled={busy}>
                            <Play className="h-4 w-4 mr-2 text-green-500" /> Resume
                        </Button>
                    }
                    <ScheduledTaskDialog tenantId={tenantId} task={task} onSaved={fetchData} />
                    <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={handleDelete} disabled={busy}>
                        <Trash2 className="h-4 w-4 mr-2" /> Delete
                    </Button>
                </div>
            </div>

            {/* Task Info */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Configuration</CardTitle>
                </CardHeader>
                <CardContent>
                    <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                            <dt className="text-muted-foreground text-xs">Status</dt>
                            <dd className="mt-0.5">
                                {task.taskStatus === "active"
                                    ? <Badge variant="secondary" className="text-green-600">Active</Badge>
                                    : <Badge variant="outline">Paused</Badge>
                                }
                            </dd>
                        </div>
                        <div>
                            <dt className="text-muted-foreground text-xs">Schedule</dt>
                            <dd className="mt-0.5 font-mono text-xs">
                                {task.scheduleType === "interval"
                                    ? `every ${task.intervalMinutes ?? "?"} min`
                                    : task.cronExpression}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-muted-foreground text-xs">Timezone</dt>
                            <dd className="mt-0.5">{task.timezone}</dd>
                        </div>
                        <div>
                            <dt className="text-muted-foreground text-xs">Mode</dt>
                            <dd className="mt-0.5 capitalize">{task.mode}</dd>
                        </div>
                        <div>
                            <dt className="text-muted-foreground text-xs">Next Run</dt>
                            <dd className="mt-0.5">{formatTime(task.nextRunAt)}</dd>
                        </div>
                        <div>
                            <dt className="text-muted-foreground text-xs">Last Run</dt>
                            <dd className="mt-0.5">{formatTime(task.lastRunAt)}</dd>
                        </div>
                        <div>
                            <dt className="text-muted-foreground text-xs">Total Runs</dt>
                            <dd className="mt-0.5">{task.runCount}</dd>
                        </div>
                        <div>
                            <dt className="text-muted-foreground text-xs">Notification</dt>
                            <dd className="mt-0.5 capitalize">{task.notification.type}</dd>
                        </div>
                    </dl>
                </CardContent>
            </Card>

            {/* Run History */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Run History</CardTitle>
                </CardHeader>
                <CardContent>
                    {runs.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                            <Clock className="h-8 w-8 mx-auto mb-2 opacity-30" />
                            <p className="text-sm">No runs yet</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {runs.map(run => {
                                const cfg = STATUS_CONFIG[run.status]
                                const StatusIcon = cfg.icon
                                return (
                                    <div
                                        key={run.runId}
                                        className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent/50 cursor-pointer transition-colors"
                                        onClick={() => router.push(`/app/agent-ops/${run.runId}?tenantId=${run.tenantId}`)}
                                    >
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-mono text-muted-foreground truncate">{run.runId}</p>
                                            <p className="text-xs text-muted-foreground mt-0.5">{formatTime(run.createdAt)}</p>
                                        </div>
                                        <div className="flex items-center gap-3 flex-shrink-0">
                                            <span className="text-xs text-muted-foreground">{formatDuration(run.durationMs)}</span>
                                            <Badge variant={cfg.variant} className="flex items-center gap-1">
                                                <StatusIcon className={`h-3 w-3 ${run.status === "in_progress" ? "animate-spin" : ""}`} />
                                                {cfg.label}
                                            </Badge>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

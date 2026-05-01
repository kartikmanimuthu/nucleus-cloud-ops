"use client"

import { useEffect, useState, useCallback } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import {
    CalendarClock, ArrowLeft, RefreshCw, Play, Pause, Trash2,
    CheckCircle2, XCircle, Clock, Loader2, AlertCircle, Zap,
} from "lucide-react"
import type { ScheduledTask } from "@/lib/agent-ops/types"
import { ScheduledTaskDialog } from "@/components/agent-ops/scheduled-task-dialog"

import { formatDateTime } from "@/lib/date-utils"
import { useTenant } from '@/lib/tenant-context'

function StatusBadge({ status }: { status: ScheduledTask["taskStatus"] }) {
    if (status === "active") return <Badge variant="secondary" className="text-green-600">Active</Badge>
    if (status === "paused") return <Badge variant="outline">Paused</Badge>
    return <Badge variant="destructive">Deleted</Badge>
}

export default function ScheduledTasksPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const tenantId = searchParams.get("tenantId") || "default"
    const { timezone } = useTenant()
    const [tasks, setTasks] = useState<ScheduledTask[]>([])
    const [loading, setLoading] = useState(true)
    const [actionIds, setActionIds] = useState<Set<string>>(new Set())

    const fetchTasks = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch(`/api/agent-ops/scheduled-tasks?tenantId=${tenantId}`)
            const data = await res.json()
            setTasks(data.tasks || [])
        } catch (err) {
            console.error("Failed to fetch tasks:", err)
        } finally {
            setLoading(false)
        }
    }, [tenantId])

    useEffect(() => { fetchTasks() }, [fetchTasks])

    const withAction = async (taskId: string, fn: () => Promise<void>) => {
        setActionIds(s => new Set(s).add(taskId))
        try { await fn() } finally {
            setActionIds(s => { const n = new Set(s); n.delete(taskId); return n })
            await fetchTasks()
        }
    }

    const handlePause = (task: ScheduledTask) => withAction(task.taskId, async () => {
        await fetch(`/api/agent-ops/scheduled-tasks/${task.taskId}/pause`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenantId }),
        })
    })

    const handleResume = (task: ScheduledTask) => withAction(task.taskId, async () => {
        await fetch(`/api/agent-ops/scheduled-tasks/${task.taskId}/resume`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenantId }),
        })
    })

    const handleDelete = (task: ScheduledTask) => withAction(task.taskId, async () => {
        if (!confirm(`Delete "${task.name}"?`)) return
        await fetch(`/api/agent-ops/scheduled-tasks/${task.taskId}?tenantId=${tenantId}`, { method: "DELETE" })
    })

    const handleTrigger = (task: ScheduledTask) => withAction(task.taskId, async () => {
        const res = await fetch(`/api/agent-ops/scheduled-tasks/${task.taskId}/trigger`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenantId }),
        })
        const data = await res.json()
        if (data.runId) router.push(`/app/agent-ops/${data.runId}?tenantId=${tenantId}`)
    })

    const formatTime = (iso?: string) => iso
        ? formatDateTime(iso, 'shortDateTime', timezone)
        : "—"

    const stats = {
        active: tasks.filter(t => t.taskStatus === "active").length,
        paused: tasks.filter(t => t.taskStatus === "paused").length,
        totalRuns: tasks.reduce((s, t) => s + (t.runCount || 0), 0),
    }

    return (
        <div className="flex-1 overflow-auto p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Button variant="ghost" size="sm" onClick={() => router.push(`/app/agent-ops?tenantId=${tenantId}`)}>
                        <ArrowLeft className="h-4 w-4 mr-1" /> Back
                    </Button>
                    <div>
                        <h1 className="text-2xl font-bold flex items-center gap-2">
                            <CalendarClock className="h-6 w-6 text-blue-500" />
                            Scheduled Tasks
                        </h1>
                        <p className="text-muted-foreground text-sm mt-0.5">Recurring agent executions on a cron schedule</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={fetchTasks} disabled={loading}>
                        <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
                        Refresh
                    </Button>
                    <ScheduledTaskDialog tenantId={tenantId} onSaved={fetchTasks} />
                </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4">
                <Card>
                    <CardContent className="pt-4 pb-3 px-4">
                        <div className="text-2xl font-bold text-green-500">{stats.active}</div>
                        <div className="text-xs text-muted-foreground">Active</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-4 pb-3 px-4">
                        <div className="text-2xl font-bold text-yellow-500">{stats.paused}</div>
                        <div className="text-xs text-muted-foreground">Paused</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-4 pb-3 px-4">
                        <div className="text-2xl font-bold">{stats.totalRuns}</div>
                        <div className="text-xs text-muted-foreground">Total Runs</div>
                    </CardContent>
                </Card>
            </div>

            {/* Task List */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-lg">Tasks</CardTitle>
                    <CardDescription>Click a task to view run history and details</CardDescription>
                </CardHeader>
                <CardContent>
                    {loading && tasks.length === 0 ? (
                        <div className="flex items-center justify-center py-12 text-muted-foreground">
                            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading...
                        </div>
                    ) : tasks.length === 0 ? (
                        <div className="text-center py-12 text-muted-foreground">
                            <CalendarClock className="h-12 w-12 mx-auto mb-3 opacity-30" />
                            <p className="font-medium">No scheduled tasks</p>
                            <p className="text-sm mt-1">Create a task to start recurring agent runs.</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {tasks.map(task => {
                                const busy = actionIds.has(task.taskId)
                                const lastStatus = task.lastRunStatus
                                return (
                                    <div
                                        key={task.taskId}
                                        className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent/50 cursor-pointer transition-colors"
                                        onClick={() => router.push(`/app/agent-ops/scheduled-tasks/${task.taskId}?tenantId=${tenantId}`)}
                                    >
                                        <div className="flex items-center gap-3 flex-1 min-w-0">
                                            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                                                <CalendarClock className="h-4 w-4" />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="font-medium text-sm truncate">{task.name}</p>
                                                <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground flex-wrap">
                                                    <span className="font-mono">{task.cronExpression}</span>
                                                    <span>•</span>
                                                    <span>{task.timezone}</span>
                                                    <span>•</span>
                                                    <span>Next: {formatTime(task.nextRunAt)}</span>
                                                    {task.lastRunAt && <><span>•</span><span>Last: {formatTime(task.lastRunAt)}</span></>}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 flex-shrink-0" onClick={e => e.stopPropagation()}>
                                            {lastStatus === "completed" && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                                            {lastStatus === "failed" && <XCircle className="h-4 w-4 text-red-500" />}
                                            {lastStatus === "in_progress" && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
                                            <StatusBadge status={task.taskStatus} />
                                            <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy}
                                                onClick={() => handleTrigger(task)} title="Run now">
                                                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                                            </Button>
                                            {task.taskStatus === "active"
                                                ? <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy}
                                                    onClick={() => handlePause(task)} title="Pause">
                                                    <Pause className="h-3 w-3" />
                                                </Button>
                                                : <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy}
                                                    onClick={() => handleResume(task)} title="Resume">
                                                    <Play className="h-3 w-3 text-green-500" />
                                                </Button>
                                            }
                                            <ScheduledTaskDialog
                                                tenantId={tenantId}
                                                task={task}
                                                onSaved={fetchTasks}
                                                trigger={
                                                    <Button variant="ghost" size="sm" className="h-7 px-2" title="Edit">
                                                        <Zap className="h-3 w-3" />
                                                    </Button>
                                                }
                                            />
                                            <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive hover:text-destructive"
                                                disabled={busy} onClick={() => handleDelete(task)} title="Delete">
                                                <Trash2 className="h-3 w-3" />
                                            </Button>
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

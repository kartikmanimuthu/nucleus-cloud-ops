"use client"

import { useState, useEffect } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { GatedButton } from "@/components/rbac/gated"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { PaginationBar } from "@/components/ui/pagination-bar"
import {
    CalendarClock, ArrowLeft, RefreshCw, Play, Pause, Trash2,
    CheckCircle2, XCircle, Loader2, Zap, ArrowDownWideNarrow,
} from "lucide-react"
import type { ScheduledTask } from "@/lib/agent-ops/types"
import type { TaskListQuery } from "@/lib/db/repositories/scheduled-task/interface"
import { ScheduledTaskDialog, SCHEDULED_TASK_PREFILL_KEY, type ScheduledTaskPrefill } from "@/components/agent-ops/scheduled-task-dialog"
import { useScheduledTasks } from "@/lib/queries/agent-ops-scheduled-tasks"
import { formatDateTime } from "@/lib/date-utils"
import { useTenant } from '@/lib/tenant-context'

function StatusBadge({ status }: { status: ScheduledTask["taskStatus"] }) {
    if (status === "active") return <Badge variant="secondary" className="text-green-600">Active</Badge>
    if (status === "paused") return <Badge variant="outline">Paused</Badge>
    return <Badge variant="destructive">Deleted</Badge>
}

const SORT_OPTIONS: { label: string; value: string }[] = [
    { label: "Created: newest first", value: "createdAt:desc" },
    { label: "Created: oldest first", value: "createdAt:asc" },
    { label: "Updated: newest first", value: "updatedAt:desc" },
    { label: "Updated: oldest first", value: "updatedAt:asc" },
    { label: "Next run", value: "nextRunAt:asc" },
    { label: "Last run", value: "lastRunAt:desc" },
    { label: "Name", value: "name:asc" },
    { label: "Status", value: "taskStatus:asc" },
    { label: "Run count", value: "runCount:desc" },
]

function parseSort(value: string): { sortBy: TaskListQuery['sortBy']; sortDir: 'asc' | 'desc' } {
    const [sortBy, sortDir] = value.split(':') as [TaskListQuery['sortBy'], 'asc' | 'desc']
    return { sortBy, sortDir }
}

export default function ScheduledTasksPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const tenantId = searchParams.get("tenantId") || "default"
    const { timezone } = useTenant()
    const [page, setPage] = useState(1)
    const [pageSize, setPageSize] = useState(25)
    const [sortValue, setSortValue] = useState<string>("createdAt:desc")
    const [actionIds, setActionIds] = useState<Set<string>>(new Set())
    const [prefill, setPrefill] = useState<ScheduledTaskPrefill | null>(null)
    const [prefillOpen, setPrefillOpen] = useState(false)

    useEffect(() => {
        if (searchParams.get("prefill") !== "1") return
        try {
            const raw = sessionStorage.getItem(SCHEDULED_TASK_PREFILL_KEY)
            if (raw) {
                setPrefill(JSON.parse(raw) as ScheduledTaskPrefill)
                setPrefillOpen(true)
            }
        } catch { /* ignore malformed draft */ }
        sessionStorage.removeItem(SCHEDULED_TASK_PREFILL_KEY)
        // strip only the prefill query param so a refresh doesn't re-open the
        // dialog, while preserving any other params (e.g. tenantId)
        const params = new URLSearchParams(searchParams.toString())
        params.delete("prefill")
        router.replace(`/app/agent-ops/scheduled-tasks${params.size ? `?${params}` : ""}`)
    }, [searchParams, router])

    const { sortBy, sortDir } = parseSort(sortValue)
    const tasksQuery = useScheduledTasks({ page, limit: pageSize, sortBy, sortDir })
    const tasks = tasksQuery.data?.tasks ?? []
    const total = tasksQuery.data?.total ?? 0
    const stats = tasksQuery.data?.stats ?? { active: 0, paused: 0, totalRuns: 0 }
    const loading = tasksQuery.isLoading

    const withAction = async (taskId: string, fn: () => Promise<void>) => {
        setActionIds(s => new Set(s).add(taskId))
        try { await fn() } finally {
            setActionIds(s => { const n = new Set(s); n.delete(taskId); return n })
            await tasksQuery.refetch()
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

    const formatSchedule = (t: ScheduledTask) => t.scheduleType === "interval"
        ? (t.intervalMinutes && t.intervalMinutes % 60 === 0
            ? `every ${t.intervalMinutes / 60}h`
            : `every ${t.intervalMinutes ?? "?"}m`)
        : t.cronExpression

    return (
        <div className="space-y-6">
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
                    <Button variant="outline" size="sm" onClick={() => tasksQuery.refetch()} disabled={tasksQuery.isFetching}>
                        <RefreshCw className={`h-4 w-4 mr-2 ${tasksQuery.isFetching ? "animate-spin" : ""}`} />
                        Refresh
                    </Button>
                    {/* Scheduled tasks authorise under the AI Ops subject `Agent`, NOT
                        `Schedule` -- the cost scheduler at /app/schedules is a different
                        feature. See libs/rbac/generated/route-manifest.json. */}
                    <ScheduledTaskDialog
                        tenantId={tenantId}
                        onSaved={() => tasksQuery.refetch()}
                        trigger={
                            <GatedButton action="create" subject="ScheduledTask" className="gap-2">
                                <CalendarClock className="h-4 w-4" />
                                New Scheduled Task
                            </GatedButton>
                        }
                    />
                    {prefill && (
                        <ScheduledTaskDialog
                            tenantId={tenantId}
                            prefill={prefill}
                            open={prefillOpen}
                            onOpenChange={(o) => { setPrefillOpen(o); if (!o) setPrefill(null); }}
                            onSaved={() => { setPrefillOpen(false); setPrefill(null); tasksQuery.refetch(); }}
                        />
                    )}
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

            {/* Sort */}
            <div className="flex items-center justify-end gap-2">
                <ArrowDownWideNarrow className="h-4 w-4 text-muted-foreground" />
                <Select value={sortValue} onValueChange={setSortValue}>
                    <SelectTrigger className="w-[200px]">
                        <SelectValue placeholder="Sort by" />
                    </SelectTrigger>
                    <SelectContent>
                        {SORT_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
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
                                                    <span className="font-mono">{formatSchedule(task)}</span>
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
                                            <GatedButton action="execute" subject="ScheduledTask" data={task as unknown as Record<string, unknown>}
                                                variant="ghost" size="sm" className="h-7 px-2" disabled={busy}
                                                onClick={() => handleTrigger(task)} title="Run now">
                                                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                                            </GatedButton>
                                            {task.taskStatus === "active"
                                                ? <GatedButton action="update" subject="ScheduledTask" data={task as unknown as Record<string, unknown>}
                                                    variant="ghost" size="sm" className="h-7 px-2" disabled={busy}
                                                    onClick={() => handlePause(task)} title="Pause">
                                                    <Pause className="h-3 w-3" />
                                                </GatedButton>
                                                : <GatedButton action="update" subject="ScheduledTask" data={task as unknown as Record<string, unknown>}
                                                    variant="ghost" size="sm" className="h-7 px-2" disabled={busy}
                                                    onClick={() => handleResume(task)} title="Resume">
                                                    <Play className="h-3 w-3 text-green-500" />
                                                </GatedButton>
                                            }
                                            <ScheduledTaskDialog
                                                tenantId={tenantId}
                                                task={task}
                                                onSaved={() => tasksQuery.refetch()}
                                                trigger={
                                                    <GatedButton action="update" subject="ScheduledTask" data={task as unknown as Record<string, unknown>}
                                                        variant="ghost" size="sm" className="h-7 px-2" title="Edit">
                                                        <Zap className="h-3 w-3" />
                                                    </GatedButton>
                                                }
                                            />
                                            <GatedButton action="delete" subject="ScheduledTask" data={task as unknown as Record<string, unknown>}
                                                disabled={busy} onClick={() => handleDelete(task)} title="Delete"
                                                variant="ghost" size="sm" className="h-7 px-2 text-destructive hover:text-destructive">
                                                <Trash2 className="h-3 w-3" />
                                            </GatedButton>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                    <div className="mt-4">
                        <PaginationBar
                            currentPage={page}
                            totalItems={total}
                            pageSize={pageSize}
                            onPageChange={setPage}
                            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
                            itemLabel="tasks"
                        />
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}

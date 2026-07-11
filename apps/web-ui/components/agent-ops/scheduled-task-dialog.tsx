"use client"

import { useState } from "react"
import { CalendarClock, Loader2, Info } from "lucide-react"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { CronPicker } from "./cron-picker"
import type { ScheduledTask } from "@/lib/agent-ops/types"

interface ScheduledTaskDialogProps {
    tenantId?: string
    task?: ScheduledTask         // if provided → edit mode
    onSaved?: (task: ScheduledTask) => void
    trigger?: React.ReactNode
}

const DEFAULT_FORM = {
    name: "",
    description: "",
    scheduleType: "cron" as "cron" | "interval",
    cronExpression: "0 9 * * *",
    intervalValue: 4,
    intervalUnit: "hours" as "minutes" | "hours",
    timezone: "UTC",
    autoApprove: false,
    notificationType: "none" as "none" | "slack" | "jira" | "telegram",
    channelId: "",
    channelName: "",
    chatId: "",
    issueKey: "",
}

const MIN_INTERVAL_MINUTES = 5

function splitIntervalMinutes(minutes: number | undefined): { intervalValue: number; intervalUnit: "minutes" | "hours" } {
    const m = minutes ?? 240
    return m >= 60 && m % 60 === 0
        ? { intervalValue: m / 60, intervalUnit: "hours" }
        : { intervalValue: m, intervalUnit: "minutes" }
}

export function ScheduledTaskDialog({ tenantId = "default", task, onSaved, trigger }: ScheduledTaskDialogProps) {
    const [open, setOpen] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [form, setForm] = useState(() => task ? {
        name: task.name,
        description: task.description,
        scheduleType: task.scheduleType ?? "cron",
        cronExpression: task.cronExpression || DEFAULT_FORM.cronExpression,
        ...splitIntervalMinutes(task.intervalMinutes),
        timezone: task.timezone,
        autoApprove: task.autoApprove,
        notificationType: task.notification.type,
        channelId: task.notification.channelId || "",
        channelName: task.notification.channelName || "",
        chatId: task.notification.chatId || "",
        issueKey: task.notification.issueKey || "",
    } : DEFAULT_FORM)

    const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }))

    const intervalMinutes = form.intervalUnit === "hours" ? form.intervalValue * 60 : form.intervalValue

    const handleSave = async () => {
        if (!form.name.trim() || !form.description.trim()) {
            setError("Name and description are required")
            return
        }
        if (form.scheduleType === "interval" && (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL_MINUTES)) {
            setError(`Interval must be at least ${MIN_INTERVAL_MINUTES} minutes`)
            return
        }
        setError(null)
        setLoading(true)
        try {
            // tenantId is resolved server-side from the session — never sent by the
            // client (a stale/placeholder value here would re-home the task's tenant).
            // Mode is not sent: Agent Ops runs are always plan-mode.
            const body = {
                name: form.name.trim(),
                description: form.description.trim(),
                scheduleType: form.scheduleType,
                cronExpression: form.scheduleType === "cron" ? form.cronExpression : "",
                intervalMinutes: form.scheduleType === "interval" ? intervalMinutes : undefined,
                timezone: form.timezone,
                autoApprove: form.autoApprove,
                notification: {
                    type: form.notificationType,
                    ...(form.notificationType === "slack" && { channelId: form.channelId, channelName: form.channelName }),
                    ...(form.notificationType === "jira" && { issueKey: form.issueKey }),
                    ...(form.notificationType === "telegram" && { chatId: form.chatId }),
                },
            }

            const url = task
                ? `/api/agent-ops/scheduled-tasks/${task.taskId}`
                : `/api/agent-ops/scheduled-tasks`
            const method = task ? "PATCH" : "POST"

            const res = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || "Failed to save")

            setOpen(false)
            onSaved?.(data.task)
        } catch (err) {
            setError(err instanceof Error ? err.message : "An error occurred")
        } finally {
            setLoading(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                {trigger ?? (
                    <Button className="gap-2">
                        <CalendarClock className="h-4 w-4" />
                        New Scheduled Task
                    </Button>
                )}
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{task ? "Edit Scheduled Task" : "New Scheduled Task"}</DialogTitle>
                    <DialogDescription>
                        Configure a recurring agent task with a cron schedule.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div className="space-y-1.5">
                        <Label>Task Name</Label>
                        <Input
                            placeholder="e.g. Daily Cost Anomaly Review"
                            value={form.name}
                            onChange={e => set("name", e.target.value)}
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label>Objective</Label>
                        <Textarea
                            placeholder="What should the agent do on each run?"
                            className="min-h-[80px]"
                            value={form.description}
                            onChange={e => set("description", e.target.value)}
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label>Schedule</Label>
                        <Select value={form.scheduleType} onValueChange={v => set("scheduleType", v)}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="cron">Cron schedule (specific times)</SelectItem>
                                <SelectItem value="interval">Fixed interval (every N minutes/hours)</SelectItem>
                            </SelectContent>
                        </Select>
                        {form.scheduleType === "cron" ? (
                            <CronPicker
                                value={form.cronExpression}
                                timezone={form.timezone}
                                onValueChange={v => set("cronExpression", v)}
                                onTimezoneChange={v => set("timezone", v)}
                            />
                        ) : (
                            <div className="space-y-1.5 pt-1">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm text-muted-foreground">Every</span>
                                    <Input
                                        type="number"
                                        min={1}
                                        className="w-24"
                                        value={form.intervalValue}
                                        onChange={e => set("intervalValue", Number(e.target.value))}
                                    />
                                    <Select value={form.intervalUnit} onValueChange={v => set("intervalUnit", v)}>
                                        <SelectTrigger className="w-32">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="minutes">minutes</SelectItem>
                                            <SelectItem value="hours">hours</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    The next run fires this long after the previous run finishes. Minimum {MIN_INTERVAL_MINUTES} minutes.
                                </p>
                            </div>
                        )}
                    </div>

                    <div className="space-y-1.5">
                        <Label>Notification</Label>
                        <Select value={form.notificationType} onValueChange={v => set("notificationType", v)}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">None (web UI only)</SelectItem>
                                <SelectItem value="slack">Slack channel</SelectItem>
                                <SelectItem value="telegram">Telegram chat</SelectItem>
                                <SelectItem value="jira">Jira issue comment</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    {form.notificationType === "slack" && (
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label className="text-xs">Channel ID</Label>
                                <Input placeholder="C0123456789" value={form.channelId} onChange={e => set("channelId", e.target.value)} />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs">Channel Name (optional)</Label>
                                <Input placeholder="#cost-alerts" value={form.channelName} onChange={e => set("channelName", e.target.value)} />
                            </div>
                        </div>
                    )}

                    {form.notificationType === "jira" && (
                        <div className="space-y-1.5">
                            <Label className="text-xs">Jira Issue Key</Label>
                            <Input placeholder="PROJ-123" value={form.issueKey} onChange={e => set("issueKey", e.target.value)} />
                        </div>
                    )}

                    {form.notificationType === "telegram" && (
                        <div className="space-y-1.5">
                            <Label className="text-xs">Telegram Chat ID</Label>
                            <Input placeholder="-1001234567890" value={form.chatId} onChange={e => set("chatId", e.target.value)} />
                            <p className="text-xs text-muted-foreground">Numeric chat ID the bot can post to (group IDs start with -100).</p>
                        </div>
                    )}

                    <div className="flex items-center justify-between rounded-lg border p-3">
                        <div>
                            <p className="text-sm font-medium">Auto-approve</p>
                            <p className="text-xs text-muted-foreground">Skip human-in-the-loop approval gates</p>
                        </div>
                        <Switch
                            checked={form.autoApprove}
                            onCheckedChange={v => set("autoApprove", v)}
                        />
                    </div>

                    {error && (
                        <div className="p-3 text-sm text-red-600 bg-red-50 dark:bg-red-950/30 rounded flex items-start gap-2 border border-red-200 dark:border-red-900">
                            <Info className="h-4 w-4 shrink-0 mt-0.5" />
                            {error}
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>Cancel</Button>
                    <Button onClick={handleSave} disabled={loading}>
                        {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                        {task ? "Save Changes" : "Create Task"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

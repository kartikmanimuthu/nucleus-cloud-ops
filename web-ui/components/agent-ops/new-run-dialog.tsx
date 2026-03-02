"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Play, Loader2, Info } from "lucide-react"
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
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"

export function NewRunDialog({
    tenantId = "default"
}: {
    tenantId?: string
}) {
    const router = useRouter()
    const [open, setOpen] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [taskDescription, setTaskDescription] = useState("")

    const handleRun = async () => {
        if (!taskDescription.trim()) {
            setError("Task description is required")
            return
        }
        setError(null)
        setLoading(true)

        try {
            const res = await fetch("/api/v1/trigger/api", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-tenant-id": tenantId,
                },
                body: JSON.stringify({
                    taskDescription: taskDescription.trim(),
                }),
            })

            const data = await res.json()
            if (!res.ok) throw new Error(data.error || "Failed to start run")

            setOpen(false)
            router.push(`/agent-ops/${data.runId}?tenantId=${tenantId}`)
        } catch (err) {
            setError(err instanceof Error ? err.message : "An unknown error occurred")
        } finally {
            setLoading(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button className="gap-2">
                    <Play className="h-4 w-4" />
                    New Agent Run
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Start Agent Run</DialogTitle>
                    <DialogDescription>
                        Describe your task. The agent will autonomously determine the best execution strategy, skill, and target account.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-5 py-4">
                    {/* Task Description */}
                    <div className="space-y-2">
                        <Label>Objective</Label>
                        <Textarea
                            placeholder="What do you want the agent to do? e.g., 'Check all Lambda functions in us-east-1 for public access'"
                            className="min-h-[100px]"
                            value={taskDescription}
                            onChange={(e) => setTaskDescription(e.target.value)}
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
                    <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
                        Cancel
                    </Button>
                    <Button onClick={handleRun} disabled={loading || !taskDescription.trim()}>
                        {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Play className="h-4 w-4 mr-2" />}
                        Trigger Run
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

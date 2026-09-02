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
import { DictationTextarea } from "@/components/voice/dictation-textarea"
import { Label } from "@/components/ui/label"
import { GatedButton } from "@/components/rbac/gated"
import type { AgentMode } from "@/lib/agent-ops/types"

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
    // Agent Ops runs on the deep agent, always. The mode picker was removed
    // deliberately (mirroring AI Ops, which went deep-only upstream in 76308ae5)
    // — there is no longer a plan/deep choice to make here. The value is still
    // sent explicitly rather than relying on the tenant default, so the run row
    // records the mode it actually executed in.
    const RUN_MODE: AgentMode = "deep"

    const handleRun = async () => {
        if (!taskDescription.trim()) {
            setError("Task description is required")
            return
        }
        setError(null)
        setLoading(true)

        try {
            // /api/v1/gateway/api, NOT /api/v1/trigger/api. The trigger path is a
            // backward-compat alias for external API-key clients and is
            // ALLOWLISTED out of the route guard; the gateway path declares
            // { POST: create Agent } and is enforced. Both reach the same handler,
            // so calling the compat alias from the browser silently skipped the
            // only permission check on starting an agent run.
            const res = await fetch("/api/v1/gateway/api", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-tenant-id": tenantId,
                },
                body: JSON.stringify({
                    taskDescription: taskDescription.trim(),
                    mode: RUN_MODE,
                }),
            })

            const data = await res.json()
            if (!res.ok) throw new Error(data.error || "Failed to start run")

            setOpen(false)
            router.push(`/app/agent-ops/${data.runId}?tenantId=${tenantId}`)
        } catch (err) {
            setError(err instanceof Error ? err.message : "An unknown error occurred")
        } finally {
            setLoading(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            {/* Starting a run is `create AgentOps` — enforced on the route this
                dialog posts to (/api/v1/gateway/api, see the fetch above).
                Deliberately NOT `create Agent`: this button lives on the Agent
                Ops page, so gating it on the interactive-agent subject meant an
                admin could hold Agent Ops in full and still find it disabled,
                with nothing on screen explaining which other submodule was
                responsible. The button and the route must be changed together —
                they are the same permission stated twice. */}
            <DialogTrigger asChild>
                <GatedButton action="create" subject="AgentOps" className="gap-2">
                    <Play className="h-4 w-4" />
                    New Agent Run
                </GatedButton>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Start Agent Run</DialogTitle>
                    <DialogDescription>
                        Describe your task. DeepAgent will autonomously determine the best execution strategy, skill, and target account.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-5 py-4">
                    {/* Task Description */}
                    <div className="space-y-2">
                        <Label>Objective</Label>
                        <DictationTextarea
                            placeholder="What do you want the agent to do? e.g., 'Check all Lambda functions in us-east-1 for public access'"
                            className="min-h-[100px]"
                            value={taskDescription}
                            onValueChange={setTaskDescription}
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

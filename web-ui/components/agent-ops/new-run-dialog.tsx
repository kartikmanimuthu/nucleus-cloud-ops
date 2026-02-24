"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Play, Loader2, Info, Plug, ChevronDown, ChevronUp } from "lucide-react"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"

interface MCPServer {
    id: string
    name: string
    description: string
    enabled: boolean
}

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

    // MCP state
    const [mcpServers, setMcpServers] = useState<MCPServer[]>([])
    const [selectedMcpIds, setSelectedMcpIds] = useState<string[]>([])
    const [mcpExpanded, setMcpExpanded] = useState(false)
    const [mcpLoading, setMcpLoading] = useState(false)

    // Fetch MCP servers when dialog opens
    useEffect(() => {
        if (!open) return
        setMcpLoading(true)
        fetch("/api/mcp-servers")
            .then(r => r.json())
            .then(data => {
                const servers: MCPServer[] = data.servers || []
                setMcpServers(servers)
                // Pre-select enabled servers
                setSelectedMcpIds(servers.filter(s => s.enabled).map(s => s.id))
            })
            .catch(() => setMcpServers([]))
            .finally(() => setMcpLoading(false))
    }, [open])

    const toggleMcp = (id: string) => {
        setSelectedMcpIds(prev =>
            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
        )
    }

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
                    mcpServerIds: selectedMcpIds,
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

    const enabledServers = mcpServers.filter(s => selectedMcpIds.includes(s.id))

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

                    {/* MCP Servers */}
                    <div className="border rounded-lg overflow-hidden">
                        <button
                            type="button"
                            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
                            onClick={() => setMcpExpanded(v => !v)}
                        >
                            <div className="flex items-center gap-2">
                                <Plug className="h-4 w-4 text-muted-foreground" />
                                <span>MCP Servers</span>
                                {enabledServers.length > 0 && (
                                    <Badge variant="secondary" className="text-xs">
                                        {enabledServers.length} active
                                    </Badge>
                                )}
                            </div>
                            {mcpExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                        </button>

                        {mcpExpanded && (
                            <div className="border-t px-4 py-3 space-y-2 bg-muted/20">
                                {mcpLoading ? (
                                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        Loading servers...
                                    </div>
                                ) : mcpServers.length === 0 ? (
                                    <p className="text-sm text-muted-foreground py-1">
                                        No MCP servers configured.{" "}
                                        <a href="/agent-ops/mcp-settings" className="text-primary underline-offset-2 hover:underline">
                                            Configure servers
                                        </a>
                                    </p>
                                ) : (
                                    mcpServers.map(server => (
                                        <div key={server.id} className="flex items-start gap-3 py-1">
                                            <Checkbox
                                                id={`mcp-${server.id}`}
                                                checked={selectedMcpIds.includes(server.id)}
                                                onCheckedChange={() => toggleMcp(server.id)}
                                                className="mt-0.5"
                                            />
                                            <label htmlFor={`mcp-${server.id}`} className="flex-1 cursor-pointer">
                                                <p className="text-sm font-medium leading-none">{server.name}</p>
                                                <p className="text-xs text-muted-foreground mt-0.5">{server.description}</p>
                                            </label>
                                        </div>
                                    ))
                                )}
                                <p className="text-xs text-muted-foreground pt-1">
                                    Selected servers will be connected for this run only.
                                </p>
                            </div>
                        )}
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

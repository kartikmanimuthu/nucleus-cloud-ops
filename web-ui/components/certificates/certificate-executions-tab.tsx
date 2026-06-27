"use client";

import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Loader2 } from "lucide-react";

interface ExecutionRecord {
    id: string;
    operation: string;
    accountId: string | null;
    region: string | null;
    status: string;
    message: string | null;
    startedAt: string;
    finishedAt: string | null;
    duration: number | null;
    triggeredBy: string;
}

interface Props {
    certificateId: string;
    refreshKey?: number;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
    running: { label: "Running", className: "bg-blue-500/10 text-blue-500" },
    success: { label: "Success", className: "bg-green-500/10 text-green-500" },
    partial: { label: "Partial", className: "bg-amber-500/10 text-amber-500" },
    failed: { label: "Failed", className: "bg-red-500/10 text-red-500" },
};

export function CertificateExecutionsTab({ certificateId, refreshKey }: Props) {
    const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);

    const fetchExecutions = useCallback(async () => {
        try {
            const res = await fetch(`/api/certificates/${certificateId}/executions?limit=100`);
            const json = await res.json();
            if (json.success) setExecutions(json.data);
        } catch (e) {
            console.error("Failed to fetch executions:", e);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [certificateId]);

    useEffect(() => {
        fetchExecutions();
    }, [fetchExecutions, refreshKey]);

    if (loading) return <div className="p-4 text-muted-foreground">Loading...</div>;

    const statusBadge = (status: string) => {
        const b = STATUS_BADGE[status] ?? { label: status, className: "" };
        return <Badge variant="outline" className={b.className}>{b.label}</Badge>;
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                    Discover, deploy, and reimport operations for this certificate.
                </p>
                <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    disabled={refreshing}
                    onClick={() => { setRefreshing(true); fetchExecutions(); }}
                >
                    {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    Refresh
                </Button>
            </div>

            {executions.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">No execution history yet.</div>
            ) : (
                <div className="rounded-md border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Operation</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Account</TableHead>
                                <TableHead>Region</TableHead>
                                <TableHead>Started</TableHead>
                                <TableHead>Duration</TableHead>
                                <TableHead>Details</TableHead>
                                <TableHead>By</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {executions.map(ex => (
                                <TableRow key={ex.id}>
                                    <TableCell className="font-medium capitalize">{ex.operation}</TableCell>
                                    <TableCell>{statusBadge(ex.status)}</TableCell>
                                    <TableCell className="font-mono text-sm">{ex.accountId || "—"}</TableCell>
                                    <TableCell className="font-mono text-sm">{ex.region || "—"}</TableCell>
                                    <TableCell className="text-sm text-muted-foreground">
                                        {new Date(ex.startedAt).toLocaleString()}
                                    </TableCell>
                                    <TableCell className="text-sm text-muted-foreground">
                                        {ex.duration != null ? `${ex.duration}s` : "—"}
                                    </TableCell>
                                    <TableCell className="text-sm max-w-xs truncate" title={ex.message || ""}>
                                        {ex.message || "—"}
                                    </TableCell>
                                    <TableCell className="text-xs text-muted-foreground">{ex.triggeredBy}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}
        </div>
    );
}

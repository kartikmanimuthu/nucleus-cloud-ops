"use client";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import type { MemoryRow } from "@/lib/queries/agent-memories";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="min-w-0 break-words">{value}</span>
        </div>
    );
}

export function MemoryDetailDialog({
    memory,
    onClose,
}: {
    memory: MemoryRow | null;
    onClose: () => void;
}) {
    return (
        <Dialog open={!!memory} onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent className="max-w-2xl">
                <DialogHeader className="min-w-0">
                    <DialogTitle className="break-words">{memory?.key}</DialogTitle>
                    <DialogDescription className="break-words">{memory?.namespace}</DialogDescription>
                </DialogHeader>
                {memory ? (
                    <div className="min-w-0 space-y-3">
                        <Row label="Fact" value={memory.fact || <em className="text-muted-foreground">none</em>} />
                        <Row label="Source" value={memory.source ?? "—"} />
                        <Row
                            label="Confidence"
                            value={memory.confidence ? <Badge variant="secondary">{memory.confidence}</Badge> : "—"}
                        />
                        <Row label="Category" value={<Badge variant="outline">{memory.category}</Badge>} />
                        <Row label="Created" value={new Date(memory.createdAt).toLocaleString()} />
                        <Row label="Updated" value={new Date(memory.updatedAt).toLocaleString()} />
                        <Row label="Expires" value={new Date(memory.expiresAt).toLocaleString()} />
                        <div className="space-y-1">
                            <span className="text-sm text-muted-foreground">Raw value</span>
                            <pre className="max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
                                {JSON.stringify(memory.value, null, 2)}
                            </pre>
                        </div>
                    </div>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

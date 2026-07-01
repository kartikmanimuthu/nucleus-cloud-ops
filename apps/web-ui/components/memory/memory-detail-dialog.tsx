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
        <div className="grid grid-cols-[120px_1fr] gap-2 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="break-words">{value}</span>
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
                <DialogHeader>
                    <DialogTitle className="break-words">{memory?.key}</DialogTitle>
                    <DialogDescription>{memory?.namespace}</DialogDescription>
                </DialogHeader>
                {memory ? (
                    <div className="space-y-3">
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
                            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
                                {JSON.stringify(memory.value, null, 2)}
                            </pre>
                        </div>
                    </div>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

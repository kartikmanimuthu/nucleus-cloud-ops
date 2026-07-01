"use client";

import { useState } from "react";
import { Brain } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { KNOWN_CATEGORIES, type MemoryCategory } from "@/lib/agent-memory/category";
import {
    useAgentMemories,
    useDeleteAgentMemory,
    type MemoryRow,
} from "@/lib/queries/agent-memories";
import { useDebounce } from "@/hooks/use-debounce";
import { MemoryDetailDialog } from "./memory-detail-dialog";
import { DeleteMemoryDialog } from "./delete-memory-dialog";

type Tab = "all" | MemoryCategory;
const TABS: Tab[] = ["all", ...KNOWN_CATEGORIES, "other"];
const TAB_LABEL: Record<Tab, string> = {
    all: "All",
    infra: "Infra",
    user: "User",
    patterns: "Patterns",
    errors: "Errors",
    other: "Other",
};

export function MemoryClientComponent() {
    const [tab, setTab] = useState<Tab>("all");
    const [searchInput, setSearchInput] = useState("");
    const search = useDebounce(searchInput, 300);
    const [detail, setDetail] = useState<MemoryRow | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<MemoryRow | null>(null);

    const { data, isLoading } = useAgentMemories({
        category: tab === "all" ? undefined : tab,
        search: search || undefined,
        limit: 200,
    });
    const memories = data?.data ?? [];
    const del = useDeleteAgentMemory();

    const handleDelete = () => {
        if (!deleteTarget) return;
        const target = deleteTarget;
        del.mutate(target.id, {
            onSuccess: () => {
                toast.success("Memory deleted", { description: target.key });
                setDeleteTarget(null);
            },
            onError: (e) => {
                toast.error("Failed to delete memory", {
                    description: e instanceof Error ? e.message : undefined,
                });
            },
        });
    };

    return (
        <div className="space-y-4">
            <PageHeader
                icon={Brain}
                title="Memory"
                description="What the AI Ops agent has learned across sessions. Review and prune as needed."
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-1">
                    {TABS.map((t) => (
                        <Button
                            key={t}
                            variant={tab === t ? "default" : "outline"}
                            size="sm"
                            onClick={() => setTab(t)}
                        >
                            {TAB_LABEL[t]}
                        </Button>
                    ))}
                </div>
                <Input
                    placeholder="Search key or fact…"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    className="w-full max-w-xs"
                />
            </div>

            {isLoading ? (
                <div className="flex justify-center py-16">
                    <Spinner />
                </div>
            ) : memories.length === 0 ? (
                <div className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
                    No memories yet — the AI Ops agent will populate these as it works.
                </div>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Category</TableHead>
                                <TableHead>Key</TableHead>
                                <TableHead>Fact</TableHead>
                                <TableHead>Confidence</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead>Expires</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {memories.map((m) => (
                                <TableRow
                                    key={m.id}
                                    className="cursor-pointer"
                                    onClick={() => setDetail(m)}
                                >
                                    <TableCell>
                                        <Badge variant="outline">{m.category}</Badge>
                                    </TableCell>
                                    <TableCell className="font-medium">{m.key}</TableCell>
                                    <TableCell className="max-w-md truncate">{m.fact}</TableCell>
                                    <TableCell>{m.confidence ?? "—"}</TableCell>
                                    <TableCell>{new Date(m.createdAt).toLocaleDateString()}</TableCell>
                                    <TableCell>{new Date(m.expiresAt).toLocaleDateString()}</TableCell>
                                    <TableCell className="text-right">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setDeleteTarget(m);
                                            }}
                                        >
                                            Delete
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            <MemoryDetailDialog memory={detail} onClose={() => setDetail(null)} />
            <DeleteMemoryDialog
                target={deleteTarget}
                pending={del.isPending}
                onCancel={() => setDeleteTarget(null)}
                onConfirm={handleDelete}
            />
        </div>
    );
}

"use client";

import { useMemo, useState } from "react";
import type { ColumnDef, PaginationState, SortingState } from "@tanstack/react-table";
import { Brain, MoreHorizontal, Eye, Trash2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { DataTableFacetedFilter } from "@/components/ui/data-table-faceted-filter";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KNOWN_CATEGORIES, type MemoryCategory } from "@/lib/agent-memory/category";
import {
    useAgentMemories,
    useDeleteAgentMemory,
    type MemoryRow,
    type MemorySortField,
} from "@/lib/queries/agent-memories";
import { useDebounce } from "@/hooks/use-debounce";
import { MemoryDetailDialog } from "./memory-detail-dialog";
import { DeleteMemoryDialog } from "./delete-memory-dialog";

const CATEGORY_OPTIONS: { label: string; value: MemoryCategory }[] = [
    ...KNOWN_CATEGORIES,
    "other" as const,
].map((c) => ({ label: c.charAt(0).toUpperCase() + c.slice(1), value: c }));

function confidenceVariant(c: string | null): "default" | "secondary" | "outline" {
    if (c === "high") return "default";
    if (c === "medium") return "secondary";
    return "outline";
}

export function MemoryClientComponent() {
    const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
    const [sorting, setSorting] = useState<SortingState>([]);
    const [searchInput, setSearchInput] = useState("");
    const search = useDebounce(searchInput, 300);
    const [categories, setCategories] = useState<MemoryCategory[]>([]);
    const [detail, setDetail] = useState<MemoryRow | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<MemoryRow | null>(null);

    const sort = sorting[0];
    const { data, isLoading } = useAgentMemories({
        page: pagination.pageIndex + 1,
        limit: pagination.pageSize,
        categories: categories.length ? categories : undefined,
        search: search || undefined,
        sortBy: sort ? (sort.id as MemorySortField) : undefined,
        sortDir: sort ? (sort.desc ? "desc" : "asc") : undefined,
    });
    const memories = data?.data ?? [];
    const total = data?.total ?? 0;
    const del = useDeleteAgentMemory();

    // Any server-side filter change must return to the first page.
    const resetToFirstPage = () => setPagination((p) => ({ ...p, pageIndex: 0 }));
    // Sorting is server-side too, so a new sort must also reset to page 1.
    const handleSortingChange: typeof setSorting = (updater) => {
        setSorting(updater);
        resetToFirstPage();
    };
    const handleSearchChange = (v: string) => {
        setSearchInput(v);
        resetToFirstPage();
    };
    const handleCategoriesChange = (values: string[]) => {
        setCategories(values as MemoryCategory[]);
        resetToFirstPage();
    };
    const clearFilters = () => {
        setSearchInput("");
        setCategories([]);
        resetToFirstPage();
    };

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

    const columns = useMemo<ColumnDef<MemoryRow>[]>(
        () => [
            {
                accessorKey: "category",
                header: ({ column }) => <DataTableColumnHeader column={column} title="Category" />,
                cell: ({ row }) => <Badge variant="outline">{row.original.category}</Badge>,
            },
            {
                accessorKey: "key",
                header: ({ column }) => <DataTableColumnHeader column={column} title="Key" />,
                cell: ({ row }) => (
                    <button
                        type="button"
                        onClick={() => setDetail(row.original)}
                        className="text-left font-medium hover:underline"
                    >
                        {row.original.key}
                    </button>
                ),
            },
            {
                accessorKey: "fact",
                header: "Fact",
                enableSorting: false,
                cell: ({ row }) => (
                    <span className="block max-w-md truncate">{row.original.fact}</span>
                ),
            },
            {
                accessorKey: "confidence",
                header: "Confidence",
                enableSorting: false,
                cell: ({ row }) =>
                    row.original.confidence ? (
                        <Badge variant={confidenceVariant(row.original.confidence)}>
                            {row.original.confidence}
                        </Badge>
                    ) : (
                        <span className="text-muted-foreground">—</span>
                    ),
            },
            {
                accessorKey: "createdAt",
                header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
                cell: ({ row }) => (
                    <span className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(row.original.createdAt).toLocaleDateString()}
                    </span>
                ),
            },
            {
                accessorKey: "expiresAt",
                header: ({ column }) => <DataTableColumnHeader column={column} title="Expires" />,
                cell: ({ row }) => (
                    <span className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(row.original.expiresAt).toLocaleDateString()}
                    </span>
                ),
            },
            {
                id: "actions",
                header: () => <div className="text-right">Actions</div>,
                enableSorting: false,
                cell: ({ row }) => {
                    const m = row.original;
                    return (
                        <div className="flex justify-end">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" className="h-8 w-8 p-0">
                                        <span className="sr-only">Open actions</span>
                                        <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => setDetail(m)}>
                                        <Eye className="mr-2 h-4 w-4" />
                                        View details
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => setDeleteTarget(m)}
                                        className="text-destructive"
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Delete
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    );
                },
            },
        ],
        []
    );

    const hasFilters = search.length > 0 || categories.length > 0;

    return (
        <div className="space-y-4">
            <PageHeader
                icon={Brain}
                title="Memory"
                description="What the AI Ops agent has learned across sessions. Review and prune as needed."
            />

            <DataTable
                columns={columns}
                data={memories}
                loading={isLoading}
                enableFiltering={false}
                manualPagination
                manualSorting
                sorting={sorting}
                onSortingChange={handleSortingChange}
                rowCount={total}
                pagination={pagination}
                onPaginationChange={setPagination}
                emptyMessage={
                    hasFilters
                        ? "No memories match your filters."
                        : "No memories yet — the AI Ops agent will populate these as it works."
                }
                header={
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative max-w-xs flex-1">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                placeholder="Search key or fact…"
                                value={searchInput}
                                onChange={(e) => handleSearchChange(e.target.value)}
                                className="pl-9"
                            />
                        </div>
                        <DataTableFacetedFilter
                            title="Category"
                            options={CATEGORY_OPTIONS}
                            selected={categories}
                            onChange={handleCategoriesChange}
                        />
                        {hasFilters && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={clearFilters}
                                className="h-9 px-2 lg:px-3"
                            >
                                Reset
                                <X className="ml-2 h-4 w-4" />
                            </Button>
                        )}
                    </div>
                }
            />

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

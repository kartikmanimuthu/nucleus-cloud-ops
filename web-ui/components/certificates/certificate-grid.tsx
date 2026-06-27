"use client";

import {
    useReactTable,
    getCoreRowModel,
    getSortedRowModel,
    flexRender,
    ColumnDef,
    SortingState,
} from "@tanstack/react-table";
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, Trash2 } from "lucide-react";
import { daysUntilExpiry, getExpiryColor, maskDomain } from "@/lib/certificate-utils";

export interface CertificateRow {
    id: string;
    name: string;
    domainName: string;
    status: 'active' | 'expiring' | 'expired' | 'no_material';
    issuer: string | null;
    notAfter: string | null;
    associatedAccountIds: string[];
    associatedAccountNames: string[];
}

interface CertificateGridProps {
    data: CertificateRow[];
    onRowClick: (cert: CertificateRow) => void;
    onDownload: (cert: CertificateRow) => void;
    onDelete: (cert: CertificateRow) => void;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
    active: "default",
    expiring: "secondary",
    expired: "destructive",
};

export function CertificateGrid({ data, onRowClick, onDownload, onDelete }: CertificateGridProps) {
    const [sorting, setSorting] = useState<SortingState>([{ id: "notAfter", desc: false }]);

    const columns: ColumnDef<CertificateRow>[] = [
        {
            id: "name",
            accessorKey: "name",
            header: "Name",
            cell: ({ getValue }) => getValue<string>(),
        },
        {
            id: "domainName",
            accessorKey: "domainName",
            header: "Domain",
            cell: ({ getValue }) => (
                <span className="font-mono text-sm">{maskDomain(getValue<string>())}</span>
            ),
        },
        {
            id: "status",
            accessorKey: "status",
            header: "Status",
            cell: ({ getValue }) => {
                const value = getValue<string>();
                return (
                    <Badge variant={STATUS_VARIANT[value] || "outline"}>
                        {value.charAt(0).toUpperCase() + value.slice(1)}
                    </Badge>
                );
            },
        },
        {
            id: "notAfter",
            accessorKey: "notAfter",
            header: "Expiry",
            cell: ({ getValue }) => {
                const dateStr = getValue<string | null>();
                if (!dateStr) return <span className="font-mono text-sm text-muted-foreground">—</span>;
                const days = daysUntilExpiry(dateStr);
                const color = getExpiryColor(days);
                return (
                    <span className={`font-mono text-sm ${color}`}>
                        {new Date(dateStr).toLocaleDateString()}
                    </span>
                );
            },
        },
        {
            id: "accounts",
            accessorKey: "associatedAccountIds",
            header: "Accounts",
            cell: ({ row }) => (
                <Badge variant="outline" className="text-xs">
                    {row.original.associatedAccountIds.length} account
                    {row.original.associatedAccountIds.length !== 1 ? "s" : ""}
                </Badge>
            ),
        },
        {
            id: "issuer",
            accessorKey: "issuer",
            header: "Issuer",
            cell: ({ getValue }) => getValue<string>() || "—",
        },
        {
            id: "actions",
            header: "",
            cell: ({ row }) => (
                <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => onDownload(row.original)}
                    >
                        <Download className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => onDelete(row.original)}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            ),
        },
    ];

    const table = useReactTable({
        data,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        onSortingChange: setSorting,
        state: { sorting },
    });

    return (
        <div className="rounded-md border overflow-x-auto">
            <Table>
                <TableHeader>
                    {table.getHeaderGroups().map(headerGroup => (
                        <TableRow key={headerGroup.id}>
                            {headerGroup.headers.map(header => (
                                <TableHead key={header.id}>
                                    {header.isPlaceholder
                                        ? null
                                        : flexRender(
                                              header.column.columnDef.header,
                                              header.getContext()
                                          )}
                                </TableHead>
                            ))}
                        </TableRow>
                    ))}
                </TableHeader>
                <TableBody>
                    {table.getRowModel().rows.map(row => {
                        const days = row.original.notAfter ? daysUntilExpiry(row.original.notAfter) : NaN;
                        const isExpiringSoon = !Number.isNaN(days) && days >= 0 && days <= 60;
                        return (
                            <TableRow
                                key={row.id}
                                className={`cursor-pointer hover:bg-muted/50 ${
                                    isExpiringSoon ? "bg-amber-500/5" : ""
                                }`}
                                onClick={() => onRowClick(row.original)}
                            >
                                {row.getVisibleCells().map(cell => (
                                    <TableCell key={cell.id}>
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </TableCell>
                                ))}
                            </TableRow>
                        );
                    })}
                    {data.length === 0 && (
                        <TableRow>
                            <TableCell colSpan={columns.length} className="text-center py-8 text-muted-foreground">
                                No certificates found. Upload your first certificate to get started.
                            </TableCell>
                        </TableRow>
                    )}
                </TableBody>
            </Table>
        </div>
    );
}

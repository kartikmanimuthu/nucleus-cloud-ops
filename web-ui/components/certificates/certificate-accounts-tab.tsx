"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Eye, RefreshCw, Loader2 } from "lucide-react";
import { daysUntilExpiry, getExpiryColor } from "@/lib/certificate-utils";

interface AccountInfo {
    accountId: string;
    accountName: string;
    active: boolean;
    connectionStatus: string;
    regions: string[];
    acmNotAfter: string | null;
    linkState: string;
    lastScannedAt: string | null;
    resourceCount: number;
}

interface CertificateAccountsTabProps {
    certificateId: string;
    onReimport?: (accountId: string) => void;
    reimporting?: string | null;
    refreshKey?: number;
}

const LINK_STATE_BADGE: Record<string, { label: string; className: string }> = {
    deployed: { label: "Deployed", className: "bg-green-500/10 text-green-500" },
    discovered: { label: "Discovered", className: "bg-blue-500/10 text-blue-500" },
    missing: { label: "Missing", className: "bg-amber-500/10 text-amber-500" },
    error: { label: "Error", className: "bg-red-500/10 text-red-500" },
};

export function CertificateAccountsTab({
    certificateId,
    onReimport,
    reimporting,
    refreshKey,
}: CertificateAccountsTabProps) {
    const router = useRouter();
    const [accounts, setAccounts] = useState<AccountInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [currentPage, setCurrentPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);

    useEffect(() => {
        async function fetchAccounts() {
            try {
                const res = await fetch(`/api/certificates/${certificateId}/accounts`);
                const json = await res.json();
                if (json.success) setAccounts(json.data.accounts);
            } catch (e) {
                console.error("Failed to fetch accounts:", e);
            } finally {
                setLoading(false);
            }
        }
        fetchAccounts();
    }, [certificateId, refreshKey]);

    const handleView = (accountId: string) => {
        router.push(`/app/certificates/${certificateId}/accounts/${accountId}`);
    };

    const totalItems = accounts.length;
    const totalPages = Math.ceil(totalItems / pageSize);
    const safePage = Math.min(currentPage, Math.max(1, totalPages));
    const start = (safePage - 1) * pageSize;
    const paginatedAccounts = accounts.slice(start, start + pageSize);

    if (loading) return <div className="p-4 text-muted-foreground">Loading...</div>;

    if (accounts.length === 0) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                No linked accounts yet. Click <span className="font-medium">Discover / Rescan</span> to scan
                ACM across your active accounts, or <span className="font-medium">Deploy to Account</span> to
                import this certificate.
            </div>
        );
    }

    const linkBadge = (state: string) => {
        const b = LINK_STATE_BADGE[state] ?? { label: state, className: "" };
        return <Badge variant="outline" className={b.className}>{b.label}</Badge>;
    };

    const expiryCell = (iso: string | null) => {
        if (!iso) return <span className="text-muted-foreground">—</span>;
        const days = daysUntilExpiry(iso);
        return (
            <span className={`font-mono text-sm ${getExpiryColor(days)}`}>
                {new Date(iso).toLocaleDateString()}
                {days >= 0 && days <= 60 ? ` (${days}d)` : ""}
            </span>
        );
    };

    return (
        <div className="space-y-4">
            <div className="rounded-md border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Account</TableHead>
                            <TableHead>Account ID</TableHead>
                            <TableHead>Link State</TableHead>
                            <TableHead>ACM Expiry</TableHead>
                            <TableHead>In Use By</TableHead>
                            <TableHead>Last Scanned</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {paginatedAccounts.map(account => (
                            <TableRow key={account.accountId}>
                                <TableCell className="font-medium">
                                    {account.accountName}
                                    {!account.active && (
                                        <Badge variant="outline" className="ml-2 text-xs">inactive</Badge>
                                    )}
                                </TableCell>
                                <TableCell className="font-mono text-sm">{account.accountId}</TableCell>
                                <TableCell>{linkBadge(account.linkState)}</TableCell>
                                <TableCell>{expiryCell(account.acmNotAfter)}</TableCell>
                                <TableCell>
                                    <Badge variant="outline">{account.resourceCount} resource(s)</Badge>
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                    {account.lastScannedAt
                                        ? new Date(account.lastScannedAt).toLocaleString()
                                        : "—"}
                                </TableCell>
                                <TableCell className="text-right">
                                    <div className="flex items-center justify-end gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1 h-8"
                                            onClick={() => handleView(account.accountId)}
                                        >
                                            <Eye className="h-3.5 w-3.5" />
                                            View
                                        </Button>
                                        {onReimport && (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="gap-1 h-8"
                                                disabled={reimporting === account.accountId}
                                                onClick={() => onReimport(account.accountId)}
                                            >
                                                {reimporting === account.accountId ? (
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                ) : (
                                                    <RefreshCw className="h-3.5 w-3.5" />
                                                )}
                                                Reimport
                                            </Button>
                                        )}
                                    </div>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>

            <PaginationBar
                currentPage={safePage}
                totalItems={totalItems}
                pageSize={pageSize}
                onPageChange={setCurrentPage}
                onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
                pageSizeOptions={[10, 25, 50, 100]}
                itemLabel="accounts"
            />
        </div>
    );
}

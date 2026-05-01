"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Eye, RefreshCw, Loader2 } from "lucide-react";

interface AccountInfo {
    accountId: string;
    accountName: string;
    regions: string[];
    connectionStatus: string;
    resourceCount: number;
}

interface CertificateAccountsTabProps {
    certificateId: string;
    onReimport?: (accountId: string) => void;
    reimporting?: string | null;
    refreshKey?: number;
}

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
                if (json.success) {
                    setAccounts(json.data.accounts);
                }
            } catch (e) {
                console.error('Failed to fetch accounts:', e);
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
    const end = start + pageSize;
    const paginatedAccounts = accounts.slice(start, end);

    if (loading) {
        return <div className="p-4 text-muted-foreground">Loading...</div>;
    }

    if (accounts.length === 0) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                No associated accounts found. Upload a certificate with a domain name
                matching existing ACM certificates in your inventory.
            </div>
        );
    }

    const connectedBadge = (status: string) => {
        if (status === 'connected') {
            return <Badge variant="default" className="bg-green-500/10 text-green-500">Connected</Badge>;
        }
        if (status === 'error') {
            return <Badge variant="destructive">Error</Badge>;
        }
        return <Badge variant="outline">{status}</Badge>;
    };

    return (
        <div className="space-y-4">
            <div className="rounded-md border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Account</TableHead>
                            <TableHead>Account ID</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Resources</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {paginatedAccounts.map(account => (
                            <TableRow key={account.accountId}>
                                <TableCell className="font-medium">{account.accountName}</TableCell>
                                <TableCell className="font-mono text-sm">{account.accountId}</TableCell>
                                <TableCell>{connectedBadge(account.connectionStatus)}</TableCell>
                                <TableCell>
                                    <Badge variant="outline">{account.resourceCount} cert(s)</Badge>
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

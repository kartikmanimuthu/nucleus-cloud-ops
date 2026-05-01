"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Loader2 } from "lucide-react";

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
}

export function CertificateAccountsTab({
    certificateId,
    onReimport,
    reimporting,
}: CertificateAccountsTabProps) {
    const [accounts, setAccounts] = useState<AccountInfo[]>([]);
    const [loading, setLoading] = useState(true);

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
    }, [certificateId]);

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
        <div className="rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead>Account ID</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Resources</TableHead>
                        {onReimport && <TableHead>Action</TableHead>}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {accounts.map(account => (
                        <TableRow key={account.accountId}>
                            <TableCell className="font-medium">{account.accountName}</TableCell>
                            <TableCell className="font-mono text-sm">{account.accountId}</TableCell>
                            <TableCell>{connectedBadge(account.connectionStatus)}</TableCell>
                            <TableCell>
                                <Badge variant="outline">{account.resourceCount} cert(s)</Badge>
                            </TableCell>
                            {onReimport && (
                                <TableCell>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="gap-1"
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
                                </TableCell>
                            )}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

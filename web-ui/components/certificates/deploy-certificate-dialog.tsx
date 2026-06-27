"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Loader2, UploadCloud } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface AccountOption {
    accountId: string;
    name: string;
    regions: string[];
    connectionStatus: string;
    active: boolean;
}

interface DeployCertificateDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    certificateId: string;
    onDeployed: () => void;
    excludedAccountIds?: string[];
}

export function DeployCertificateDialog({
    open,
    onOpenChange,
    certificateId,
    onDeployed,
    excludedAccountIds = [],
}: DeployCertificateDialogProps) {
    const { toast } = useToast();
    const [accounts, setAccounts] = useState<AccountOption[]>([]);
    const [regions, setRegions] = useState<{ value: string; label: string }[]>([]);
    const [loadingAccounts, setLoadingAccounts] = useState(false);
    const [loadingRegions, setLoadingRegions] = useState(false);
    const [selectedAccountId, setSelectedAccountId] = useState("");
    const [selectedRegion, setSelectedRegion] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        async function fetchAccounts() {
            setLoadingAccounts(true);
            try {
                const res = await fetch("/api/accounts?limit=1000");
                const json = await res.json();
                if (json.success) {
                    const allAccounts: AccountOption[] = json.data.map((a: {
                        accountId: string;
                        name: string;
                        regions: string[];
                        connectionStatus: string;
                        active?: boolean;
                    }) => ({
                        accountId: a.accountId,
                        name: a.name,
                        regions: a.regions || [],
                        connectionStatus: a.connectionStatus,
                        active: a.active !== false,
                    }));
                    // Only active accounts that don't already have this certificate.
                    const filtered = allAccounts.filter(
                        a => a.active && !excludedAccountIds.includes(a.accountId)
                    );
                    setAccounts(filtered);
                }
            } catch {
                setError("Failed to load accounts");
            } finally {
                setLoadingAccounts(false);
            }
        }
        fetchAccounts();
    }, [open, excludedAccountIds]);

    useEffect(() => {
        if (!open) return;
        async function fetchRegions() {
            setLoadingRegions(true);
            try {
                const res = await fetch("/api/regions");
                const json = await res.json();
                if (json.success) {
                    setRegions(json.data.map((r: { value: string; label: string }) => ({
                        value: r.value,
                        label: r.label,
                    })));
                }
            } catch {
                setError("Failed to load regions");
            } finally {
                setLoadingRegions(false);
            }
        }
        fetchRegions();
    }, [open]);

    useEffect(() => {
        // Default region when account changes
        if (selectedAccountId) {
            const account = accounts.find(a => a.accountId === selectedAccountId);
            if (account && account.regions.length > 0) {
                setSelectedRegion(account.regions[0]);
            } else {
                setSelectedRegion("us-east-1");
            }
        }
    }, [selectedAccountId, accounts]);

    const resetForm = () => {
        setSelectedAccountId("");
        setSelectedRegion("");
        setError("");
    };

    const handleDeploy = async () => {
        setError("");
        if (!selectedAccountId) {
            setError("Please select an account");
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch(`/api/certificates/${certificateId}/deploy`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    accountId: selectedAccountId,
                    region: selectedRegion || undefined,
                }),
            });
            const json = await res.json();
            if (!json.success) {
                setError(json.error || "Deploy failed");
                toast({ title: "Deploy failed", description: json.error || "Deploy failed", variant: "destructive" });
            } else {
                resetForm();
                onOpenChange(false);
                toast({ title: "Certificate deployed", description: `Account ${selectedAccountId} / ${selectedRegion}` });
                onDeployed();
            }
        } catch {
            setError("Network error — please try again");
            toast({ title: "Deploy failed", description: "Network error — please try again", variant: "destructive" });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Deploy to Account</DialogTitle>
                    <DialogDescription>
                        Import this certificate into a new AWS account via ACM.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div className="space-y-2">
                        <Label htmlFor="account">AWS Account</Label>
                        <Select
                            value={selectedAccountId}
                            onValueChange={setSelectedAccountId}
                            disabled={loadingAccounts || accounts.length === 0}
                        >
                            <SelectTrigger id="account" className="w-full">
                                <SelectValue placeholder={
                                    loadingAccounts
                                        ? "Loading accounts..."
                                        : accounts.length === 0
                                            ? "No available accounts"
                                            : "Select an account"
                                } />
                            </SelectTrigger>
                            <SelectContent>
                                {accounts.map(account => (
                                    <SelectItem key={account.accountId} value={account.accountId}>
                                        {account.name}{" "}
                                        <span className="text-muted-foreground text-xs">
                                            ({account.accountId})
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {accounts.length === 0 && !loadingAccounts && (
                            <p className="text-xs text-muted-foreground">
                                All accounts already have this certificate.
                            </p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="region">Region</Label>
                        <Select
                            value={selectedRegion}
                            onValueChange={setSelectedRegion}
                            disabled={!selectedAccountId || loadingRegions}
                        >
                            <SelectTrigger id="region" className="w-full">
                                <SelectValue placeholder={
                                    loadingRegions ? "Loading regions..." : "Select a region"
                                } />
                            </SelectTrigger>
                            <SelectContent>
                                {regions.map(region => (
                                    <SelectItem key={region.value} value={region.value}>
                                        {region.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                            Choose us-east-1 if this certificate will be used with CloudFront.
                        </p>
                    </div>

                    {error && (
                        <p className="text-sm text-destructive">{error}</p>
                    )}
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => { resetForm(); onOpenChange(false); }}
                        disabled={submitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        disabled={submitting || !selectedAccountId}
                        onClick={handleDeploy}
                    >
                        {submitting ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                            <UploadCloud className="h-4 w-4 mr-2" />
                        )}
                        Deploy
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

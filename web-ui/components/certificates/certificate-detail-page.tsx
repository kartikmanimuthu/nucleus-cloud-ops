"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, ShieldCheck, UploadCloud, Radar, Loader2 } from "lucide-react";
import { CertificateDetailTab } from "./certificate-detail-tab";
import { CertificateAccountsTab } from "./certificate-accounts-tab";
import { CertificateVersionsTab } from "./certificate-versions-tab";
import { CertificateExecutionsTab } from "./certificate-executions-tab";
import { DeployCertificateDialog } from "./deploy-certificate-dialog";
import { daysUntilExpiry, getExpiryColor } from "@/lib/certificate-utils";
import { useToast } from "@/hooks/use-toast";

interface CertificateDetailPageProps {
    certificateId: string;
}

interface ActiveVersion {
    version: number;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string;
}

interface CertificateMeta {
    id: string;
    name: string;
    domainName: string;
    status: string;
    activeVersion: ActiveVersion | null;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    active: "default",
    expiring: "secondary",
    expired: "destructive",
    no_material: "outline",
};

export function CertificateDetailPage({ certificateId }: CertificateDetailPageProps) {
    const router = useRouter();
    const { toast } = useToast();
    const [cert, setCert] = useState<CertificateMeta | null>(null);
    const [accountIds, setAccountIds] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [reimporting, setReimporting] = useState<string | null>(null);
    const [deployOpen, setDeployOpen] = useState(false);
    const [discovering, setDiscovering] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    const fetchMeta = useCallback(async () => {
        try {
            const res = await fetch(`/api/certificates/${certificateId}`);
            const json = await res.json();
            if (json.success) setCert(json.data);
        } catch (e) {
            console.error("Failed to fetch certificate:", e);
        }
    }, [certificateId]);

    const fetchAccountIds = useCallback(async () => {
        try {
            const res = await fetch(`/api/certificates/${certificateId}/accounts`);
            const json = await res.json();
            if (json.success) {
                setAccountIds(json.data.accounts.map((a: { accountId: string }) => a.accountId));
            }
        } catch (e) {
            console.error("Failed to fetch accounts:", e);
        }
    }, [certificateId]);

    useEffect(() => {
        Promise.all([fetchMeta(), fetchAccountIds()]).finally(() => setLoading(false));
    }, [fetchMeta, fetchAccountIds]);

    const refreshAll = () => {
        fetchMeta();
        fetchAccountIds();
        setRefreshKey(k => k + 1);
    };

    const handleReimport = async (accountId: string) => {
        setReimporting(accountId);
        try {
            const res = await fetch(`/api/certificates/${certificateId}/reimport`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountId }),
            });
            const json = await res.json();
            if (!json.success) {
                toast({ title: "Reimport failed", description: json.error || "Reimport failed", variant: "destructive" });
            } else if (json.data?.status === "partial") {
                toast({ title: "Reimport partially succeeded", description: json.error || "Some regions failed — see Execution History.", variant: "destructive" });
                refreshAll();
            } else {
                toast({ title: "Reimport complete", description: `Pushed active version to account ${accountId}.` });
                refreshAll();
            }
        } catch {
            toast({ title: "Reimport failed", description: "Network error", variant: "destructive" });
        } finally {
            setReimporting(null);
        }
    };

    const handleDiscover = async () => {
        setDiscovering(true);
        try {
            const res = await fetch(`/api/certificates/${certificateId}/discover`, { method: "POST" });
            const json = await res.json();
            if (!json.success) {
                toast({ title: "Discover failed", description: json.error || "Scan failed", variant: "destructive" });
                return;
            }
            const d = json.data;
            toast({
                title: `Discover complete (${d.status})`,
                description: `${d.matched} ACM match(es) across ${d.accountsScanned} active account(s).`,
            });
            refreshAll();
        } catch {
            toast({ title: "Discover failed", description: "Network error", variant: "destructive" });
        } finally {
            setDiscovering(false);
        }
    };

    if (loading) {
        return <div className="p-8 text-center text-muted-foreground">Loading certificate...</div>;
    }
    if (!cert) {
        return <div className="p-8 text-center text-muted-foreground">Certificate not found.</div>;
    }

    const notAfter = cert.activeVersion?.notAfter ?? null;
    const days = notAfter ? daysUntilExpiry(notAfter) : NaN;
    const expiryColor = Number.isNaN(days) ? "" : getExpiryColor(days);

    return (
        <div className="p-6 space-y-6">
            <Button variant="outline" size="sm" className="gap-2" onClick={() => router.push("/app/certificates")}>
                <ArrowLeft className="h-4 w-4" />
                All Certificates
            </Button>

            <div className="flex items-start justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-3">
                        <ShieldCheck className="h-6 w-6 text-muted-foreground" />
                        <h1 className="text-2xl font-bold tracking-tight">{cert.name}</h1>
                        <Badge variant={STATUS_VARIANT[cert.status] || "outline"}>
                            {cert.status === "no_material"
                                ? "No material"
                                : cert.status.charAt(0).toUpperCase() + cert.status.slice(1)}
                        </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground font-mono">{cert.domainName}</p>
                </div>
                <div className="flex flex-col items-end gap-3">
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={handleDiscover} disabled={discovering}>
                        {discovering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
                        {discovering ? "Discovering..." : "Discover / Rescan"}
                    </Button>
                    <div className="text-right text-sm space-y-1">
                        <div>
                            <span className="text-muted-foreground">Issuer: </span>
                            <span>{cert.activeVersion?.issuer || "Unknown"}</span>
                        </div>
                        <div>
                            <span className="text-muted-foreground">Active version: </span>
                            <span className="font-mono">{cert.activeVersion ? `v${cert.activeVersion.version}` : "—"}</span>
                        </div>
                        <div>
                            <span className="text-muted-foreground">Expires: </span>
                            <span className={`font-mono ${expiryColor}`}>
                                {notAfter ? new Date(notAfter).toLocaleDateString() : "—"}
                                {!Number.isNaN(days) && days >= 0 && days <= 60 ? ` (${days} days)` : ""}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <Tabs defaultValue="details" className="w-full">
                <TabsList>
                    <TabsTrigger value="details">Details</TabsTrigger>
                    <TabsTrigger value="accounts">Accounts ({accountIds.length})</TabsTrigger>
                    <TabsTrigger value="versions">Versions</TabsTrigger>
                    <TabsTrigger value="history">Execution History</TabsTrigger>
                </TabsList>

                <TabsContent value="details" className="pt-4">
                    <CertificateDetailTab certificateId={certificateId} />
                </TabsContent>

                <TabsContent value="accounts" className="pt-4">
                    <div className="flex items-center justify-between mb-4">
                        <p className="text-sm text-muted-foreground">
                            Accounts where this certificate is deployed or discovered (ACM, live).
                        </p>
                        <Button variant="outline" size="sm" className="gap-1" onClick={() => setDeployOpen(true)}>
                            <UploadCloud className="h-3.5 w-3.5" />
                            Deploy to Account
                        </Button>
                    </div>
                    <CertificateAccountsTab
                        certificateId={certificateId}
                        onReimport={handleReimport}
                        reimporting={reimporting}
                        refreshKey={refreshKey}
                    />
                </TabsContent>

                <TabsContent value="versions" className="pt-4">
                    <CertificateVersionsTab
                        certificateId={certificateId}
                        domainName={cert.domainName}
                        refreshKey={refreshKey}
                        onChanged={refreshAll}
                    />
                </TabsContent>

                <TabsContent value="history" className="pt-4">
                    <CertificateExecutionsTab certificateId={certificateId} refreshKey={refreshKey} />
                </TabsContent>
            </Tabs>

            <DeployCertificateDialog
                open={deployOpen}
                onOpenChange={setDeployOpen}
                certificateId={certificateId}
                onDeployed={refreshAll}
                excludedAccountIds={accountIds}
            />
        </div>
    );
}

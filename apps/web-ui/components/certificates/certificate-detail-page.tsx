"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GatedButton } from "@/components/rbac/gated";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, ShieldCheck, UploadCloud, Radar, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { CertificateDetailTab } from "./certificate-detail-tab";
import { CertificateAccountsTab } from "./certificate-accounts-tab";
import { CertificateVersionsTab } from "./certificate-versions-tab";
import { CertificateExecutionsTab } from "./certificate-executions-tab";
import { DeployCertificateDialog } from "./deploy-certificate-dialog";
import { daysUntilExpiry, getExpiryColor } from "@/lib/certificate-utils";
import {
    useCertificate,
    useCertificateAccounts,
    useDiscoverCertificate,
} from "@/lib/queries/certificates";

interface CertificateDetailPageProps {
    certificateId: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    active: "default",
    expiring: "secondary",
    expired: "destructive",
    no_material: "outline",
};

export function CertificateDetailPage({ certificateId }: CertificateDetailPageProps) {
    const router = useRouter();
    const [deployOpen, setDeployOpen] = useState(false);

    const { data: cert, isLoading } = useCertificate(certificateId);
    const { data: accounts = [] } = useCertificateAccounts(certificateId);
    const discover = useDiscoverCertificate();

    const handleDiscover = async () => {
        try {
            const d = await discover.mutateAsync(certificateId);
            toast.success(`Discover complete (${d.status})`, {
                description: `${d.matched} ACM match(es) across ${d.accountsScanned} active account(s).`,
            });
        } catch (e) {
            toast.error("Discover failed", {
                description: e instanceof Error ? e.message : "Scan failed",
            });
        }
    };

    if (isLoading) {
        return <div className="p-8 text-center text-muted-foreground">Loading certificate...</div>;
    }
    if (!cert) {
        return <div className="p-8 text-center text-muted-foreground">Certificate not found.</div>;
    }

    const excludedAccountIds = accounts.map((a) => a.accountId);
    const notAfter = cert.activeVersion?.notAfter ?? null;
    const days = notAfter ? daysUntilExpiry(notAfter) : NaN;
    const expiryColor = Number.isNaN(days) ? "" : getExpiryColor(days);

    return (
        <div className="p-6 space-y-6">
            <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => router.push("/app/certificates")}
            >
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
                    <GatedButton
                        action="update"
                        subject="Certificate"
                        data={{ domain: cert.domainName }}
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={handleDiscover}
                        disabled={discover.isPending}
                    >
                        {discover.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Radar className="h-3.5 w-3.5" />
                        )}
                        {discover.isPending ? "Discovering..." : "Discover / Rescan"}
                    </GatedButton>
                    <div className="text-right text-sm space-y-1">
                        <div>
                            <span className="text-muted-foreground">Issuer: </span>
                            <span>{cert.activeVersion?.issuer || "Unknown"}</span>
                        </div>
                        <div>
                            <span className="text-muted-foreground">Active version: </span>
                            <span className="font-mono">
                                {cert.activeVersion ? `v${cert.activeVersion.version}` : "—"}
                            </span>
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
                    <TabsTrigger value="accounts">Accounts ({accounts.length})</TabsTrigger>
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
                        <GatedButton
                            action="update"
                            subject="Certificate"
                            data={{ domain: cert.domainName }}
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            onClick={() => setDeployOpen(true)}
                        >
                            <UploadCloud className="h-3.5 w-3.5" />
                            Deploy to Account
                        </GatedButton>
                    </div>
                    <CertificateAccountsTab certificateId={certificateId} />
                </TabsContent>

                <TabsContent value="versions" className="pt-4">
                    <CertificateVersionsTab
                        certificateId={certificateId}
                        domainName={cert.domainName}
                    />
                </TabsContent>

                <TabsContent value="history" className="pt-4">
                    <CertificateExecutionsTab certificateId={certificateId} />
                </TabsContent>
            </Tabs>

            <DeployCertificateDialog
                open={deployOpen}
                onOpenChange={setDeployOpen}
                certificateId={certificateId}
                excludedAccountIds={excludedAccountIds}
            />
        </div>
    );
}

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { CertificateDetailTab } from "./certificate-detail-tab";
import { CertificateAccountsTab } from "./certificate-accounts-tab";
import { CertificateResourcesTab } from "./certificate-resources-tab";
import { daysUntilExpiry, getExpiryColor } from "@/lib/certificate-utils";

interface CertificateDetailPageProps {
    certificateId: string;
}

interface CertificateMeta {
    id: string;
    name: string;
    domainName: string;
    status: string;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string;
    associatedAccountIds: string[];
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
    active: "default",
    expiring: "secondary",
    expired: "destructive",
};

export function CertificateDetailPage({ certificateId }: CertificateDetailPageProps) {
    const router = useRouter();
    const [cert, setCert] = useState<CertificateMeta | null>(null);
    const [loading, setLoading] = useState(true);
    const [reimporting, setReimporting] = useState<string | null>(null);

    useEffect(() => {
        async function fetchMeta() {
            try {
                const res = await fetch(`/api/certificates/${certificateId}`);
                const json = await res.json();
                if (json.success) {
                    setCert(json.data);
                }
            } catch (e) {
                console.error("Failed to fetch certificate:", e);
            } finally {
                setLoading(false);
            }
        }
        fetchMeta();
    }, [certificateId]);

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
                throw new Error(json.error || "Reimport failed");
            }
        } finally {
            setReimporting(null);
        }
    };

    if (loading) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                Loading certificate...
            </div>
        );
    }

    if (!cert) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                Certificate not found.
            </div>
        );
    }

    const days = daysUntilExpiry(cert.notAfter);
    const expiryColor = getExpiryColor(days);

    return (
        <div className="p-6 space-y-6">
            {/* Back button */}
            <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => router.push("/app/certificates")}
            >
                <ArrowLeft className="h-4 w-4" />
                All Certificates
            </Button>

            {/* Header */}
            <div className="flex items-start justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-3">
                        <ShieldCheck className="h-6 w-6 text-muted-foreground" />
                        <h1 className="text-2xl font-bold tracking-tight">{cert.name}</h1>
                        <Badge variant={STATUS_VARIANT[cert.status] || "outline"}>
                            {cert.status.charAt(0).toUpperCase() + cert.status.slice(1)}
                        </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground font-mono">
                        {cert.domainName}
                    </p>
                </div>
                <div className="text-right text-sm space-y-1">
                    <div>
                        <span className="text-muted-foreground">Issuer: </span>
                        <span>{cert.issuer || "Unknown"}</span>
                    </div>
                    <div>
                        <span className="text-muted-foreground">Valid From: </span>
                        <span className="font-mono">
                            {cert.notBefore
                                ? new Date(cert.notBefore).toLocaleDateString()
                                : "—"}
                        </span>
                    </div>
                    <div>
                        <span className="text-muted-foreground">Expires: </span>
                        <span className={`font-mono ${expiryColor}`}>
                            {new Date(cert.notAfter).toLocaleDateString()}
                            {days >= 0 && days <= 60 ? ` (${days} days)` : ""}
                        </span>
                    </div>
                </div>
            </div>

            {/* Tabs */}
            <Tabs defaultValue="details" className="w-full">
                <TabsList>
                    <TabsTrigger value="details">Details</TabsTrigger>
                    <TabsTrigger value="accounts">
                        Accounts ({cert.associatedAccountIds.length})
                    </TabsTrigger>
                    <TabsTrigger value="resources">Resources</TabsTrigger>
                </TabsList>

                <TabsContent value="details" className="pt-4">
                    <CertificateDetailTab certificateId={certificateId} />
                </TabsContent>

                <TabsContent value="accounts" className="pt-4">
                    <CertificateAccountsTab
                        certificateId={certificateId}
                        onReimport={handleReimport}
                        reimporting={reimporting}
                    />
                </TabsContent>

                <TabsContent value="resources" className="pt-4">
                    <CertificateResourcesTab certificateId={certificateId} />
                </TabsContent>
            </Tabs>
        </div>
    );
}

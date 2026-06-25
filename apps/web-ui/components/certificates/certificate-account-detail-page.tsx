"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, RefreshCw, Loader2, ShieldCheck } from "lucide-react";

interface AssociatedResource {
    arn: string;
    type: string;
    service: string;
}

interface AcmCertificate {
    arn: string;
    status: string;
    domainName: string;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string | null;
    serial: string | null;
    signatureAlgorithm: string | null;
    type: string | null;
    importedAt: string | null;
    inUseBy: AssociatedResource[];
}

interface AccountInfo {
    accountId: string;
    name: string;
}

interface CertificateAccountDetail {
    certificate: AcmCertificate;
    account: AccountInfo;
}

interface CertificateAccountDetailPageProps {
    certificateId: string;
    accountId: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    ISSUED: "default",
    ACTIVE: "default",
    PENDING_VALIDATION: "secondary",
    INACTIVE: "secondary",
    EXPIRED: "destructive",
    FAILED: "destructive",
    VALIDATION_TIMED_OUT: "destructive",
    REVOKED: "destructive",
};

const SERVICE_COLORS: Record<string, string> = {
    ELB: "bg-blue-500/10 text-blue-500",
    CloudFront: "bg-orange-500/10 text-orange-500",
    "API Gateway": "bg-purple-500/10 text-purple-500",
    Cognito: "bg-green-500/10 text-green-500",
};

export function CertificateAccountDetailPage({
    certificateId,
    accountId,
}: CertificateAccountDetailPageProps) {
    const router = useRouter();
    const [data, setData] = useState<CertificateAccountDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [reimporting, setReimporting] = useState(false);

    useEffect(() => {
        async function fetchData() {
            try {
                const res = await fetch(`/api/certificates/${certificateId}/accounts/${accountId}`);
                const json = await res.json();
                if (json.success) {
                    setData(json.data);
                }
            } catch (e) {
                console.error("Failed to fetch account certificate detail:", e);
            } finally {
                setLoading(false);
            }
        }
        fetchData();
    }, [certificateId, accountId]);

    const handleReimport = async () => {
        setReimporting(true);
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
        } catch (e) {
            console.error("Reimport failed:", e);
        } finally {
            setReimporting(false);
        }
    };

    if (loading) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                Loading certificate details...
            </div>
        );
    }

    if (!data) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                Certificate or account not found.
            </div>
        );
    }

    const { certificate: cert, account } = data;
    const statusVariant = STATUS_VARIANT[cert.status] || "outline";

    const metaItems = [
        { label: "ARN", value: cert.arn },
        { label: "Status", value: cert.status },
        { label: "Type", value: cert.type || "—" },
        { label: "Issuer", value: cert.issuer || "—" },
        { label: "Serial", value: cert.serial || "—" },
        { label: "Signature Algorithm", value: cert.signatureAlgorithm || "—" },
        { label: "Not Before", value: cert.notBefore ? new Date(cert.notBefore).toLocaleDateString() : "—" },
        { label: "Not After", value: cert.notAfter ? new Date(cert.notAfter).toLocaleDateString() : "—" },
        { label: "Imported At", value: cert.importedAt ? new Date(cert.importedAt).toLocaleDateString() : "—" },
    ];

    return (
        <div className="p-6 space-y-6">
            {/* Back button */}
            <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => router.push(`/app/certificates/${certificateId}`)}
            >
                <ArrowLeft className="h-4 w-4" />
                Back to Certificate
            </Button>

            {/* Header */}
            <div className="flex items-start justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-3">
                        <ShieldCheck className="h-6 w-6 text-muted-foreground" />
                        <h1 className="text-2xl font-bold tracking-tight">{cert.domainName}</h1>
                        <Badge variant={statusVariant}>
                            {cert.status}
                        </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                        Account: <span className="font-medium">{account.name}</span>{" "}
                        <span className="font-mono text-xs">({account.accountId})</span>
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    disabled={reimporting}
                    onClick={handleReimport}
                >
                    {reimporting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Reimport
                </Button>
            </div>

            {/* Certificate Info */}
            <div className="space-y-3">
                <h2 className="text-lg font-semibold">Certificate Information</h2>
                <div className="grid grid-cols-3 gap-4 text-sm">
                    {metaItems.map((item) => (
                        <div key={item.label} className="space-y-0.5">
                            <span className="text-muted-foreground text-xs">{item.label}</span>
                            <p className={item.label === "ARN" ? "font-mono text-xs break-all" : ""}>
                                {item.value}
                            </p>
                        </div>
                    ))}
                </div>
            </div>

            {/* Associated Resources */}
            <div className="space-y-3">
                <h2 className="text-lg font-semibold">Associated Resources</h2>
                {cert.inUseBy.length === 0 ? (
                    <div className="p-6 text-center text-muted-foreground border rounded-md">
                        No associated resources found.
                        <p className="text-sm mt-1">
                            This certificate is not attached to any ALB, CloudFront distribution, or API Gateway in this account.
                        </p>
                    </div>
                ) : (
                    <div className="rounded-md border">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Resource ARN</TableHead>
                                    <TableHead>Type</TableHead>
                                    <TableHead>Service</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {cert.inUseBy.map((r, i) => (
                                    <TableRow key={`${r.arn}-${i}`}>
                                        <TableCell className="font-mono text-xs max-w-lg truncate">
                                            {r.arn}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline" className="text-xs">
                                                {r.type}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <Badge
                                                variant="outline"
                                                className={`text-xs ${SERVICE_COLORS[r.service] || ""}`}
                                            >
                                                {r.service}
                                            </Badge>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </div>
        </div>
    );
}

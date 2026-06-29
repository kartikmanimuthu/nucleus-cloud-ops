"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { ArrowLeft, RefreshCw, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
    useCertificateAccountDetail,
    useReimportCertificate,
} from "@/lib/queries/certificates";

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
    const { data, isLoading, error } = useCertificateAccountDetail(certificateId, accountId);
    const reimport = useReimportCertificate();

    const handleReimport = async () => {
        try {
            const result = await reimport.mutateAsync({ certId: certificateId, accountId });
            if (result.data?.status === "partial") {
                toast.warning("Reimport partially succeeded", {
                    description: result.error || "Some regions failed — see Execution History.",
                });
            } else if (result.data?.status === "failed" || !result.success) {
                toast.error("Reimport failed", {
                    description: result.error || "Reimport failed",
                });
            } else {
                toast.success("Reimport complete", {
                    description: `Pushed active version to account ${accountId}.`,
                });
            }
        } catch (e) {
            toast.error("Reimport failed", {
                description: e instanceof Error ? e.message : "Network error — please try again",
            });
        }
    };

    if (isLoading) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                Loading certificate details...
            </div>
        );
    }

    if (!data) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                {error instanceof Error ? error.message : "Certificate or account not found."}
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
        {
            label: "Not Before",
            value: cert.notBefore ? new Date(cert.notBefore).toLocaleDateString() : "—",
        },
        {
            label: "Not After",
            value: cert.notAfter ? new Date(cert.notAfter).toLocaleDateString() : "—",
        },
        {
            label: "Imported At",
            value: cert.importedAt ? new Date(cert.importedAt).toLocaleDateString() : "—",
        },
    ];

    return (
        <div className="p-6 space-y-6">
            <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => router.push(`/app/certificates/${certificateId}`)}
            >
                <ArrowLeft className="h-4 w-4" />
                Back to Certificate
            </Button>

            <div className="flex items-start justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-3">
                        <ShieldCheck className="h-6 w-6 text-muted-foreground" />
                        <h1 className="text-2xl font-bold tracking-tight">{cert.domainName}</h1>
                        <Badge variant={statusVariant}>{cert.status}</Badge>
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
                    disabled={reimport.isPending}
                    onClick={handleReimport}
                >
                    {reimport.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Reimport
                </Button>
            </div>

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

            <div className="space-y-3">
                <h2 className="text-lg font-semibold">Associated Resources</h2>
                {cert.inUseBy.length === 0 ? (
                    <div className="p-6 text-center text-muted-foreground border rounded-md">
                        No associated resources found.
                        <p className="text-sm mt-1">
                            This certificate is not attached to any ALB, CloudFront distribution,
                            or API Gateway in this account.
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

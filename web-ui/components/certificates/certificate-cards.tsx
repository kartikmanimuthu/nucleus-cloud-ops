"use client";

import { useRouter } from "next/navigation";
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    ShieldCheck,
    Download,
    Trash2,
    Eye,
    MoreHorizontal,
    Calendar,
    Building,
    Loader2,
    Radar,
} from "lucide-react";
import { daysUntilExpiry, getExpiryColor, maskDomain } from "@/lib/certificate-utils";

export interface CertificateCard {
    id: string;
    name: string;
    domainName: string;
    status: 'active' | 'expiring' | 'expired' | 'no_material';
    issuer: string | null;
    notAfter: string | null;
    associatedAccountIds: string[];
    associatedAccountNames: string[];
}

interface CertificateCardsProps {
    data: CertificateCard[];
    onCardClick: (cert: CertificateCard) => void;
    onDownload: (cert: CertificateCard) => void;
    onDelete: (cert: CertificateCard) => void;
    onDiscover?: (cert: CertificateCard) => void;
    discoveringId?: string | null;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
    active: "default",
    expiring: "secondary",
    expired: "destructive",
};

export function CertificateCards({
    data,
    onCardClick,
    onDownload,
    onDelete,
    onDiscover,
    discoveringId,
}: CertificateCardsProps) {
    const router = useRouter();

    return (
        <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {data.map((cert) => {
                    const days = cert.notAfter ? daysUntilExpiry(cert.notAfter) : NaN;
                    const expiryColor = Number.isNaN(days) ? "" : getExpiryColor(days);
                    const isExpiringSoon = !Number.isNaN(days) && days >= 0 && days <= 60;

                    return (
                        <Card
                            key={cert.id}
                            className={`relative hover:shadow-md transition-shadow cursor-pointer ${
                                isExpiringSoon ? "border-amber-500/50" : ""
                            }`}
                            onClick={() => onCardClick(cert)}
                        >
                            <CardHeader className="pb-3">
                                <div className="flex items-start justify-between">
                                    <div className="space-y-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <ShieldCheck className="h-4 w-4 text-muted-foreground shrink-0" />
                                            <CardTitle className="text-lg truncate">
                                                {cert.name}
                                            </CardTitle>
                                        </div>
                                        <CardDescription className="font-mono text-sm truncate">
                                            {maskDomain(cert.domainName)}
                                        </CardDescription>
                                    </div>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                className="h-8 w-8 p-0 shrink-0"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <MoreHorizontal className="h-4 w-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    router.push(`/app/certificates/${cert.id}`);
                                                }}
                                            >
                                                <Eye className="mr-2 h-4 w-4" />
                                                View Details
                                            </DropdownMenuItem>
                                            {onDiscover && (
                                                <DropdownMenuItem
                                                    disabled={discoveringId === cert.id}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onDiscover(cert);
                                                    }}
                                                >
                                                    {discoveringId === cert.id ? (
                                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <Radar className="mr-2 h-4 w-4" />
                                                    )}
                                                    Discover / Rescan
                                                </DropdownMenuItem>
                                            )}
                                            <DropdownMenuItem
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onDownload(cert);
                                                }}
                                            >
                                                <Download className="mr-2 h-4 w-4" />
                                                Download
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onDelete(cert);
                                                }}
                                                className="text-destructive"
                                            >
                                                <Trash2 className="mr-2 h-4 w-4" />
                                                Delete
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                            </CardHeader>

                            <CardContent className="space-y-3 pb-3">
                                {/* Status */}
                                <div className="flex items-center justify-between">
                                    <Badge variant={STATUS_VARIANT[cert.status] || "outline"}>
                                        {cert.status.charAt(0).toUpperCase() + cert.status.slice(1)}
                                    </Badge>
                                    <div className="flex items-center gap-1.5">
                                        <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                                        <span className={`text-sm font-mono ${expiryColor}`}>
                                            {cert.notAfter
                                                ? new Date(cert.notAfter).toLocaleDateString()
                                                : "—"}
                                            {!Number.isNaN(days) && days >= 0 && days <= 60 ? ` (${days}d)` : ""}
                                        </span>
                                    </div>
                                </div>

                                {/* Issuer */}
                                <div className="text-sm text-muted-foreground truncate">
                                    Issuer: {cert.issuer || "Unknown"}
                                </div>

                                {/* Accounts */}
                                <div className="flex items-center gap-1.5">
                                    <Building className="h-3.5 w-3.5 text-muted-foreground" />
                                    <Badge variant="outline" className="text-xs">
                                        {cert.associatedAccountIds.length} account
                                        {cert.associatedAccountIds.length !== 1 ? "s" : ""}
                                    </Badge>
                                </div>
                            </CardContent>

                            <CardFooter className="flex items-center justify-between pt-3 border-t bg-muted/20">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 text-xs gap-1"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDownload(cert);
                                    }}
                                >
                                    <Download className="h-3.5 w-3.5" />
                                    Download
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 text-xs gap-1 text-destructive hover:text-destructive"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDelete(cert);
                                    }}
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    Delete
                                </Button>
                            </CardFooter>
                        </Card>
                    );
                })}
            </div>

            {data.length === 0 && (
                <div className="text-center py-12">
                    <ShieldCheck className="mx-auto h-12 w-12 text-muted-foreground" />
                    <h3 className="mt-2 text-sm font-semibold">No certificates found</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Upload your first certificate to get started.
                    </p>
                </div>
            )}
        </div>
    );
}

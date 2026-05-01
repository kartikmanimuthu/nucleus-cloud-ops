"use client";

import { useState, useEffect } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

interface AssociatedResource {
    arn: string;
    type: string;
    service: string;
    accountId: string;
    accountName: string;
}

interface CertificateResourcesTabProps {
    certificateId: string;
}

const SERVICE_COLORS: Record<string, string> = {
    ELB: "bg-blue-500/10 text-blue-500",
    CloudFront: "bg-orange-500/10 text-orange-500",
    "API Gateway": "bg-purple-500/10 text-purple-500",
    Cognito: "bg-green-500/10 text-green-500",
};

export function CertificateResourcesTab({ certificateId }: CertificateResourcesTabProps) {
    const [resources, setResources] = useState<AssociatedResource[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchResources() {
            try {
                const res = await fetch(`/api/certificates/${certificateId}/associated-resources`);
                const json = await res.json();
                if (json.success) {
                    setResources(json.data.resources);
                }
            } catch (e) {
                console.error('Failed to fetch associated resources:', e);
            } finally {
                setLoading(false);
            }
        }
        fetchResources();
    }, [certificateId]);

    if (loading) {
        return <div className="p-4 text-muted-foreground">Loading associated resources...</div>;
    }

    if (resources.length === 0) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                No associated resources found in any account.
                <p className="text-sm mt-2">
                    This certificate may not be attached to any ALB, CloudFront distribution, or API Gateway yet.
                </p>
            </div>
        );
    }

    return (
        <div className="rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Resource ARN</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Service</TableHead>
                        <TableHead>Account</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {resources.map((r, i) => (
                        <TableRow key={`${r.arn}-${i}`}>
                            <TableCell className="font-mono text-xs max-w-md truncate">
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
                            <TableCell className="text-sm text-muted-foreground">
                                {r.accountName || r.accountId}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

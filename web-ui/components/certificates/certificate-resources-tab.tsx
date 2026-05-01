"use client";

import { useState, useEffect } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

interface ResourceInfo {
    resourceId: string;
    name: string;
    region: string;
    resourceType: string;
    accountId: string;
    accountName?: string;
}

interface CertificateResourcesTabProps {
    certificateId: string;
}

export function CertificateResourcesTab({ certificateId }: CertificateResourcesTabProps) {
    const [resources, setResources] = useState<ResourceInfo[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchResources() {
            try {
                const res = await fetch(`/api/certificates/${certificateId}/accounts`);
                const json = await res.json();
                if (json.success) {
                    const allResources: ResourceInfo[] = [];
                    for (const account of json.data.accounts) {
                        for (const r of (account as { resources: ResourceInfo[] }).resources || []) {
                            allResources.push({
                                ...r,
                                accountId: account.accountId as string,
                                accountName: account.accountName as string,
                            });
                        }
                    }
                    setResources(allResources);
                }
            } catch (e) {
                console.error('Failed to fetch resources:', e);
            } finally {
                setLoading(false);
            }
        }
        fetchResources();
    }, [certificateId]);

    if (loading) {
        return <div className="p-4 text-muted-foreground">Loading...</div>;
    }

    if (resources.length === 0) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                No associated resources found in inventory.
            </div>
        );
    }

    return (
        <div className="rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Resource</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Region</TableHead>
                        <TableHead>Account</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {resources.map((r, i) => (
                        <TableRow key={`${r.resourceId}-${i}`}>
                            <TableCell className="font-mono text-sm">
                                {r.name || r.resourceId}
                            </TableCell>
                            <TableCell>
                                <Badge variant="outline" className="text-xs">
                                    {r.resourceType}
                                </Badge>
                            </TableCell>
                            <TableCell className="text-sm">{r.region}</TableCell>
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

"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/rbac/gated";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { CheckCircle2, Download, Trash2, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { UploadVersionDialog } from "./upload-version-dialog";
import {
    useCertificateVersions,
    useActivateVersion,
    useDeleteVersion,
} from "@/lib/queries/certificates";

interface Props {
    certificateId: string;
    domainName: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
    active: "default",
    expiring: "secondary",
    expired: "destructive",
};

export function CertificateVersionsTab({ certificateId, domainName }: Props) {
    const [uploadOpen, setUploadOpen] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);

    const { data: versions = [], isLoading } = useCertificateVersions(certificateId);
    const activateMutation = useActivateVersion();
    const deleteMutation = useDeleteVersion();

    const activate = async (versionId: string) => {
        setBusyId(versionId);
        try {
            await activateMutation.mutateAsync({ certId: certificateId, versionId });
            toast.success("Version activated", {
                description: "Deploy or Reimport to apply it to accounts.",
            });
        } catch (e) {
            toast.error("Activation failed", {
                description: e instanceof Error ? e.message : "",
            });
        } finally {
            setBusyId(null);
        }
    };

    const remove = async (versionId: string) => {
        setBusyId(versionId);
        try {
            await deleteMutation.mutateAsync({ certId: certificateId, versionId });
            toast.success("Version deleted");
        } catch (e) {
            toast.error("Delete failed", {
                description: e instanceof Error ? e.message : "",
            });
        } finally {
            setBusyId(null);
        }
    };

    const download = (versionId: string) => {
        window.open(
            `/api/certificates/${certificateId}/download?versionId=${versionId}`,
            "_blank",
        );
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                    Material versions for <span className="font-mono">{domainName}</span>. One
                    version is active at a time; activate an older version to roll back.
                </p>
                <GatedButton
                    action="update"
                    subject="Certificate"
                    data={{ domain: domainName }}
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() => setUploadOpen(true)}
                >
                    <Plus className="h-3.5 w-3.5" />
                    Upload New Version
                </GatedButton>
            </div>

            {isLoading ? (
                <div className="p-4 text-muted-foreground">Loading...</div>
            ) : versions.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">No versions found.</div>
            ) : (
                <div className="rounded-md border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Version</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Valid From</TableHead>
                                <TableHead>Expires</TableHead>
                                <TableHead>Fingerprint</TableHead>
                                <TableHead>Uploaded</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {versions.map((v) => (
                                <TableRow key={v.id}>
                                    <TableCell className="font-medium">
                                        v{v.version}
                                        {v.isActive && (
                                            <Badge
                                                variant="default"
                                                className="ml-2 gap-1 bg-green-500/10 text-green-500"
                                            >
                                                <CheckCircle2 className="h-3 w-3" />
                                                Active
                                            </Badge>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant={STATUS_VARIANT[v.status] || "outline"}>
                                            {v.status.charAt(0).toUpperCase() + v.status.slice(1)}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="font-mono text-sm">
                                        {v.notBefore
                                            ? new Date(v.notBefore).toLocaleDateString()
                                            : "—"}
                                    </TableCell>
                                    <TableCell className="font-mono text-sm">
                                        {new Date(v.notAfter).toLocaleDateString()}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">
                                        {v.fingerprint ? `${v.fingerprint.slice(0, 12)}…` : "—"}
                                    </TableCell>
                                    <TableCell className="text-xs text-muted-foreground">
                                        {new Date(v.uploadedAt).toLocaleDateString()} · {v.uploadedBy}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            {!v.isActive && (
                                                <GatedButton
                                                    action="update"
                                                    subject="Certificate"
                                                    data={{ domain: domainName }}
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-8"
                                                    disabled={busyId === v.id}
                                                    onClick={() => activate(v.id)}
                                                >
                                                    {busyId === v.id ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : (
                                                        "Make Active"
                                                    )}
                                                </GatedButton>
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8"
                                                onClick={() => download(v.id)}
                                            >
                                                <Download className="h-4 w-4" />
                                            </Button>
                                            <GatedButton
                                                action="update"
                                                subject="Certificate"
                                                data={{ domain: domainName }}
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 text-destructive"
                                                disabled={v.isActive || busyId === v.id}
                                                title={
                                                    v.isActive
                                                        ? "Cannot delete the active version"
                                                        : "Delete version"
                                                }
                                                onClick={() => remove(v.id)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </GatedButton>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            <UploadVersionDialog
                open={uploadOpen}
                onOpenChange={setUploadOpen}
                certificateId={certificateId}
            />
        </div>
    );
}

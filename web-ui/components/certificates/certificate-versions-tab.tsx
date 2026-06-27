"use client";

import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, Download, Trash2, Loader2, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface VersionRecord {
    id: string;
    version: number;
    isActive: boolean;
    issuer: string | null;
    notBefore: string | null;
    notAfter: string;
    fingerprint: string | null;
    status: string;
    uploadedAt: string;
    uploadedBy: string;
}

interface Props {
    certificateId: string;
    domainName: string;
    refreshKey?: number;
    onChanged: () => void;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
    active: "default",
    expiring: "secondary",
    expired: "destructive",
};

export function CertificateVersionsTab({ certificateId, domainName, refreshKey, onChanged }: Props) {
    const { toast } = useToast();
    const [versions, setVersions] = useState<VersionRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [uploadOpen, setUploadOpen] = useState(false);

    const fetchVersions = useCallback(async () => {
        try {
            const res = await fetch(`/api/certificates/${certificateId}/versions`);
            const json = await res.json();
            if (json.success) setVersions(json.data);
        } catch (e) {
            console.error("Failed to fetch versions:", e);
        } finally {
            setLoading(false);
        }
    }, [certificateId]);

    useEffect(() => {
        fetchVersions();
    }, [fetchVersions, refreshKey]);

    const activate = async (versionId: string) => {
        setBusyId(versionId);
        try {
            const res = await fetch(`/api/certificates/${certificateId}/versions/${versionId}/activate`, {
                method: "POST",
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error || "Activation failed");
            toast({ title: "Version activated", description: "Deploy or Reimport to apply it to accounts." });
            fetchVersions();
            onChanged();
        } catch (e) {
            toast({ title: "Activation failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
        } finally {
            setBusyId(null);
        }
    };

    const remove = async (versionId: string) => {
        setBusyId(versionId);
        try {
            const res = await fetch(`/api/certificates/${certificateId}/versions/${versionId}`, {
                method: "DELETE",
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error || "Delete failed");
            toast({ title: "Version deleted" });
            fetchVersions();
            onChanged();
        } catch (e) {
            toast({ title: "Delete failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
        } finally {
            setBusyId(null);
        }
    };

    const download = (versionId: string) => {
        window.open(`/api/certificates/${certificateId}/download?versionId=${versionId}`, "_blank");
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                    Material versions for <span className="font-mono">{domainName}</span>. One version is active at a
                    time; activate an older version to roll back.
                </p>
                <Button variant="outline" size="sm" className="gap-1" onClick={() => setUploadOpen(true)}>
                    <Plus className="h-3.5 w-3.5" />
                    Upload New Version
                </Button>
            </div>

            {loading ? (
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
                            {versions.map(v => (
                                <TableRow key={v.id}>
                                    <TableCell className="font-medium">
                                        v{v.version}
                                        {v.isActive && (
                                            <Badge variant="default" className="ml-2 gap-1 bg-green-500/10 text-green-500">
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
                                        {v.notBefore ? new Date(v.notBefore).toLocaleDateString() : "—"}
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
                                                <Button
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
                                                </Button>
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8"
                                                onClick={() => download(v.id)}
                                            >
                                                <Download className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 text-destructive"
                                                disabled={v.isActive || busyId === v.id}
                                                title={v.isActive ? "Cannot delete the active version" : "Delete version"}
                                                onClick={() => remove(v.id)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
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
                onUploaded={() => {
                    fetchVersions();
                    onChanged();
                }}
            />
        </div>
    );
}

function UploadVersionDialog({
    open,
    onOpenChange,
    certificateId,
    onUploaded,
}: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    certificateId: string;
    onUploaded: () => void;
}) {
    const { toast } = useToast();
    const [body, setBody] = useState("");
    const [chain, setChain] = useState("");
    const [privateKey, setPrivateKey] = useState("");
    const [activate, setActivate] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");

    const reset = () => {
        setBody("");
        setChain("");
        setPrivateKey("");
        setActivate(false);
        setError("");
    };

    const submit = async () => {
        setError("");
        if (!body || !privateKey) {
            setError("Certificate body and private key are required");
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch(`/api/certificates/${certificateId}/versions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ body, chain: chain || undefined, privateKey, activate }),
            });
            const json = await res.json();
            if (!json.success) {
                setError(json.error || "Upload failed");
                return;
            }
            toast({ title: "Version uploaded", description: activate ? "Activated." : "Saved (not active)." });
            reset();
            onOpenChange(false);
            onUploaded();
        } catch {
            setError("Network error — please try again");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Upload New Version</DialogTitle>
                    <DialogDescription>
                        Paste renewed certificate material. It must match this certificate&apos;s domain and key pair.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 py-2">
                    <div className="space-y-1.5">
                        <Label>Certificate Body (PEM)</Label>
                        <Textarea rows={4} value={body} onChange={e => setBody(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" className="font-mono text-xs" />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Certificate Chain (PEM, optional)</Label>
                        <Textarea rows={3} value={chain} onChange={e => setChain(e.target.value)} className="font-mono text-xs" />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Private Key (PEM)</Label>
                        <Textarea rows={4} value={privateKey} onChange={e => setPrivateKey(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" className="font-mono text-xs" />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={activate} onChange={e => setActivate(e.target.checked)} />
                        Make this version active immediately
                    </label>
                    {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }} disabled={submitting}>
                        Cancel
                    </Button>
                    <Button onClick={submit} disabled={submitting}>
                        {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                        Upload
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

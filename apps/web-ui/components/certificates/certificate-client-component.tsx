"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Plus, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { CertificateGrid, type CertificateRow } from "./certificate-grid";
import { UploadCertificateDialog } from "./upload-certificate-dialog";
import { DeleteCertificateDialog } from "./delete-certificate-dialog";

export function CertificateClientComponent() {
    const router = useRouter();
    const [certificates, setCertificates] = useState<CertificateRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploadOpen, setUploadOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<CertificateRow | null>(null);

    const fetchCertificates = useCallback(async () => {
        try {
            const res = await fetch("/api/certificates?limit=100");
            const json = await res.json();
            if (json.success) {
                setCertificates(json.data);
            }
        } catch (e) {
            console.error("Failed to fetch certificates:", e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchCertificates();
    }, [fetchCertificates]);

    const handleDownload = async (cert: CertificateRow) => {
        try {
            const res = await fetch(`/api/certificates/${cert.id}/download`);
            if (!res.ok) {
                console.error("Download failed:", res.statusText);
                return;
            }
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const safeName = (cert.name || "certificate").replace(/[^a-zA-Z0-9_-]/g, "_");
            const a = document.createElement("a");
            a.href = url;
            a.download = `${safeName}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        } catch (e) {
            console.error("Download error:", e);
        }
    };

    return (
        <div className="flex h-full">
            <div className="flex-1 flex flex-col min-w-0">
                <div className="p-6 pb-4">
                    <PageHeader
                        icon={ShieldCheck}
                        title="Certificate Manager"
                        description="Manage TLS certificates across your AWS accounts"
                        actions={
                            <Button onClick={() => setUploadOpen(true)} className="gap-2">
                                <Plus className="h-4 w-4" />
                                Upload Certificate
                            </Button>
                        }
                    />
                </div>

                <div className="px-6 flex-1 overflow-auto">
                    {loading ? (
                        <div className="text-center py-12 text-muted-foreground">
                            Loading certificates...
                        </div>
                    ) : (
                        <CertificateGrid
                            data={certificates}
                            onRowClick={(cert) => router.push(`/app/certificates/${cert.id}`)}
                            onDownload={handleDownload}
                            onDelete={setDeleteTarget}
                        />
                    )}
                </div>
            </div>

            <UploadCertificateDialog
                open={uploadOpen}
                onOpenChange={setUploadOpen}
                onUploaded={fetchCertificates}
            />

            <DeleteCertificateDialog
                certificate={deleteTarget}
                open={!!deleteTarget}
                onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
                onDeleted={() => { fetchCertificates(); }}
            />
        </div>
    );
}

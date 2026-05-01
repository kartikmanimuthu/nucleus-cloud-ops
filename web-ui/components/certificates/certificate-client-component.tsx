"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
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

    return (
        <div className="flex h-full">
            <div className="flex-1 flex flex-col min-w-0">
                <div className="flex items-center justify-between p-6 pb-4">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">Certificate Manager</h1>
                        <p className="text-sm text-muted-foreground mt-1">
                            Manage TLS certificates across your AWS accounts
                        </p>
                    </div>
                    <Button onClick={() => setUploadOpen(true)} className="gap-2">
                        <Plus className="h-4 w-4" />
                        Upload Certificate
                    </Button>
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
                            onDownload={async (cert) => {
                                const res = await fetch(`/api/certificates/${cert.id}/download`);
                                const json = await res.json();
                                if (json.success) {
                                    window.open(json.data.bodyUrl, "_blank");
                                }
                            }}
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

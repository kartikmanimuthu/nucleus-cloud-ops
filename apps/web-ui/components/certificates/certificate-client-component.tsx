"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/page-header";
import { CertificateGrid } from "./certificate-grid";
import { UploadCertificateDialog } from "./upload-certificate-dialog";
import { DeleteCertificateDialog } from "./delete-certificate-dialog";
import {
    useCertificates,
    useDiscoverCertificate,
    type CertificateRow,
} from "@/lib/queries/certificates";

export function CertificateClientComponent() {
    const router = useRouter();
    const [uploadOpen, setUploadOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<CertificateRow | null>(null);
    const [discoveringId, setDiscoveringId] = useState<string | null>(null);

    const { data, isLoading } = useCertificates({ limit: 100 });
    const certificates = data?.data ?? [];
    const discover = useDiscoverCertificate();

    const handleDownload = async (cert: CertificateRow) => {
        try {
            const res = await fetch(`/api/certificates/${cert.id}/download`);
            if (!res.ok) {
                let msg = res.statusText;
                try {
                    const j = await res.json();
                    msg = j.error || msg;
                } catch {
                    /* non-JSON (e.g. the zip) — keep statusText */
                }
                toast.error("Download failed", { description: msg });
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
            toast.error("Download failed", { description: "Network error — please try again" });
        }
    };

    const handleDiscover = async (cert: CertificateRow) => {
        setDiscoveringId(cert.id);
        try {
            const d = await discover.mutateAsync(cert.id);
            toast.success(`Discover complete (${d.status})`, {
                description: `${d.matched} ACM match(es) across ${d.accountsScanned} active account(s)${
                    d.errored ? `, ${d.errored} error(s)` : ""
                }${d.skipped ? `, ${d.skipped} skipped` : ""}.`,
            });
        } catch (e) {
            toast.error("Discover failed", {
                description: e instanceof Error ? e.message : "Scan failed",
            });
        } finally {
            setDiscoveringId(null);
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
                    {isLoading ? (
                        <div className="text-center py-12 text-muted-foreground">
                            Loading certificates...
                        </div>
                    ) : (
                        <CertificateGrid
                            data={certificates}
                            onRowClick={(cert) => router.push(`/app/certificates/${cert.id}`)}
                            onDownload={handleDownload}
                            onDelete={setDeleteTarget}
                            onDiscover={handleDiscover}
                            discoveringId={discoveringId}
                        />
                    )}
                </div>
            </div>

            <UploadCertificateDialog open={uploadOpen} onOpenChange={setUploadOpen} />

            <DeleteCertificateDialog
                certificate={deleteTarget}
                open={!!deleteTarget}
                onOpenChange={(v) => {
                    if (!v) setDeleteTarget(null);
                }}
            />
        </div>
    );
}

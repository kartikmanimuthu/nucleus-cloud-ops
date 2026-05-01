"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, LayoutGrid, TableIcon } from "lucide-react";
import { CertificateGrid, type CertificateRow } from "./certificate-grid";
import { CertificateCards } from "./certificate-cards";
import { UploadCertificateDialog } from "./upload-certificate-dialog";
import { DeleteCertificateDialog } from "./delete-certificate-dialog";

export function CertificateClientComponent() {
    const router = useRouter();
    const [certificates, setCertificates] = useState<CertificateRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploadOpen, setUploadOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<CertificateRow | null>(null);
    const [viewMode, setViewMode] = useState<"table" | "grid">("grid");

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
                <div className="flex items-center justify-between p-6 pb-4">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">Certificate Manager</h1>
                        <p className="text-sm text-muted-foreground mt-1">
                            Manage TLS certificates across your AWS accounts
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <Tabs
                            value={viewMode}
                            onValueChange={(value) => setViewMode(value as "table" | "grid")}
                        >
                            <TabsList className="h-9">
                                <TabsTrigger value="table" className="px-3">
                                    <TableIcon className="h-4 w-4 mr-1.5" />
                                    Table
                                </TabsTrigger>
                                <TabsTrigger value="grid" className="px-3">
                                    <LayoutGrid className="h-4 w-4 mr-1.5" />
                                    Cards
                                </TabsTrigger>
                            </TabsList>
                        </Tabs>
                        <Button onClick={() => setUploadOpen(true)} className="gap-2">
                            <Plus className="h-4 w-4" />
                            Upload Certificate
                        </Button>
                    </div>
                </div>

                <div className="px-6 flex-1 overflow-auto">
                    {loading ? (
                        <div className="text-center py-12 text-muted-foreground">
                            Loading certificates...
                        </div>
                    ) : (
                        <>
                            {viewMode === "table" ? (
                                <CertificateGrid
                                    data={certificates}
                                    onRowClick={(cert) => router.push(`/app/certificates/${cert.id}`)}
                                    onDownload={handleDownload}
                                    onDelete={setDeleteTarget}
                                />
                            ) : (
                                <CertificateCards
                                    data={certificates}
                                    onCardClick={(cert) => router.push(`/app/certificates/${cert.id}`)}
                                    onDownload={handleDownload}
                                    onDelete={setDeleteTarget}
                                />
                            )}
                        </>
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

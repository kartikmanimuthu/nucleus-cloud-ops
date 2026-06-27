"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, LayoutGrid, TableIcon } from "lucide-react";
import { CertificateGrid, type CertificateRow } from "./certificate-grid";
import { CertificateCards } from "./certificate-cards";
import { UploadCertificateDialog } from "./upload-certificate-dialog";
import { DeleteCertificateDialog } from "./delete-certificate-dialog";
import { useToast } from "@/hooks/use-toast";

export function CertificateClientComponent() {
    const router = useRouter();
    const { toast } = useToast();
    const [certificates, setCertificates] = useState<CertificateRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploadOpen, setUploadOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<CertificateRow | null>(null);
    const [viewMode, setViewMode] = useState<"table" | "grid">("grid");
    const [discoveringId, setDiscoveringId] = useState<string | null>(null);

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
                let msg = res.statusText;
                try {
                    const j = await res.json();
                    msg = j.error || msg;
                } catch { /* non-JSON (e.g. the zip) — keep statusText */ }
                toast({ title: "Download failed", description: msg, variant: "destructive" });
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
            toast({ title: "Download failed", description: "Network error — please try again", variant: "destructive" });
        }
    };

    const handleDiscover = async (cert: CertificateRow) => {
        setDiscoveringId(cert.id);
        try {
            const res = await fetch(`/api/certificates/${cert.id}/discover`, { method: "POST" });
            const json = await res.json();
            if (!json.success) {
                toast({ title: "Discover failed", description: json.error || "Scan failed", variant: "destructive" });
                return;
            }
            const d = json.data;
            toast({
                title: `Discover complete (${d.status})`,
                description: `${d.matched} ACM match(es) across ${d.accountsScanned} active account(s)${d.errored ? `, ${d.errored} error(s)` : ""}${d.skipped ? `, ${d.skipped} skipped` : ""}.`,
            });
            fetchCertificates();
        } catch {
            toast({ title: "Discover failed", description: "Network error — please try again", variant: "destructive" });
        } finally {
            setDiscoveringId(null);
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
                                    onDiscover={handleDiscover}
                                    discoveringId={discoveringId}
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

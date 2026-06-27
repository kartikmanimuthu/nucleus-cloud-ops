"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface UploadCertificateDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onUploaded: () => void;
}

export function UploadCertificateDialog({
    open,
    onOpenChange,
    onUploaded,
}: UploadCertificateDialogProps) {
    const { toast } = useToast();
    const [name, setName] = useState("");
    const [domainName, setDomainName] = useState("");
    const [body, setBody] = useState("");
    const [chain, setChain] = useState("");
    const [privateKey, setPrivateKey] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [mode, setMode] = useState<"paste" | "file">("paste");

    const resetForm = () => {
        setName("");
        setDomainName("");
        setBody("");
        setChain("");
        setPrivateKey("");
        setError("");
    };

    const handleSubmit = async () => {
        setError("");
        if (!name || !domainName || !body || !privateKey) {
            setError("Name, domain, certificate body, and private key are required");
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch("/api/certificates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, domainName, body, chain: chain || undefined, privateKey }),
            });
            const json = await res.json();
            if (!json.success) {
                setError(json.error || "Upload failed");
                toast({ title: "Upload failed", description: json.error || "Upload failed", variant: "destructive" });
            } else {
                resetForm();
                onOpenChange(false);
                toast({ title: "Certificate uploaded", description: `${name} (${domainName})` });
                onUploaded();
            }
        } catch {
            setError("Network error — please try again");
            toast({ title: "Upload failed", description: "Network error — please try again", variant: "destructive" });
        } finally {
            setSubmitting(false);
        }
    };

    const handleFileUpload = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        const form = e.target as HTMLFormElement;
        const formData = new FormData(form);
        const bodyFile = formData.get("body") as File;
        const keyFile = formData.get("privateKey") as File;
        if (!formData.get("name") || !formData.get("domainName") || !bodyFile || !keyFile) {
            setError("Name, domain, certificate body, and private key files are required");
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch("/api/certificates", {
                method: "POST",
                body: formData,
            });
            const json = await res.json();
            if (!json.success) {
                setError(json.error || "Upload failed");
                toast({ title: "Upload failed", description: json.error || "Upload failed", variant: "destructive" });
            } else {
                resetForm();
                onOpenChange(false);
                toast({ title: "Certificate uploaded" });
                onUploaded();
            }
        } catch {
            setError("Network error — please try again");
            toast({ title: "Upload failed", description: "Network error — please try again", variant: "destructive" });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Upload Certificate</DialogTitle>
                    <DialogDescription>
                        Upload a certificate with its private key. Files are encrypted at rest in S3.
                    </DialogDescription>
                </DialogHeader>

                <Tabs value={mode} onValueChange={v => setMode(v as "paste" | "file")}>
                    <TabsList className="w-full">
                        <TabsTrigger value="paste" className="flex-1">Paste Text</TabsTrigger>
                        <TabsTrigger value="file" className="flex-1">Upload Files</TabsTrigger>
                    </TabsList>

                    <TabsContent value="paste" className="space-y-4 mt-4">
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <Label htmlFor="name">Certificate Name</Label>
                                <Input id="name" value={name} onChange={e => setName(e.target.value)} placeholder="My Wildcard Cert" />
                            </div>
                            <div>
                                <Label htmlFor="domain">Domain Name</Label>
                                <Input id="domain" value={domainName} onChange={e => setDomainName(e.target.value)} placeholder="*.example.com" />
                            </div>
                        </div>
                        <div>
                            <Label htmlFor="body">Certificate Body (PEM)</Label>
                            <Textarea id="body" value={body} onChange={e => setBody(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----\n..." className="font-mono text-xs min-h-[120px]" />
                        </div>
                        <div>
                            <Label htmlFor="chain">Certificate Chain (PEM, optional)</Label>
                            <Textarea id="chain" value={chain} onChange={e => setChain(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----\n..." className="font-mono text-xs min-h-[80px]" />
                        </div>
                        <div>
                            <Label htmlFor="key">Private Key (PEM)</Label>
                            <Textarea id="key" value={privateKey} onChange={e => setPrivateKey(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----\n..." className="font-mono text-xs min-h-[120px]" />
                        </div>
                    </TabsContent>

                    <TabsContent value="file" className="space-y-4 mt-4">
                        <form id="file-upload-form" onSubmit={handleFileUpload}>
                            <div className="grid grid-cols-2 gap-3 mb-4">
                                <div>
                                    <Label htmlFor="fname">Certificate Name</Label>
                                    <Input id="fname" name="name" placeholder="My Wildcard Cert" />
                                </div>
                                <div>
                                    <Label htmlFor="fdomain">Domain Name</Label>
                                    <Input id="fdomain" name="domainName" placeholder="*.example.com" />
                                </div>
                            </div>
                            <div className="space-y-3">
                                <div>
                                    <Label htmlFor="bodyFile">Certificate Body (.pem, .crt)</Label>
                                    <Input id="bodyFile" name="body" type="file" accept=".pem,.crt,.cer,.p7b" />
                                </div>
                                <div>
                                    <Label htmlFor="chainFile">Certificate Chain (.pem, optional)</Label>
                                    <Input id="chainFile" name="chain" type="file" accept=".pem,.crt,.cer,.p7b" />
                                </div>
                                <div>
                                    <Label htmlFor="keyFile">Private Key (.pem, .key)</Label>
                                    <Input id="keyFile" name="privateKey" type="file" accept=".pem,.key" />
                                </div>
                            </div>
                        </form>
                    </TabsContent>
                </Tabs>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button
                        disabled={submitting}
                        onClick={mode === "paste" ? handleSubmit : () => {
                            const form = document.getElementById("file-upload-form") as HTMLFormElement;
                            form?.requestSubmit();
                        }}
                    >
                        {submitting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                        {!submitting && <Upload className="h-4 w-4 mr-2" />}
                        Upload
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

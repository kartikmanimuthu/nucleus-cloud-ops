"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUploadCertificate } from "@/lib/queries/certificates";

const uploadSchema = z.object({
    name: z.string().min(1, "Certificate name is required"),
    domainName: z.string().min(1, "Domain name is required"),
    body: z.string().min(1, "Certificate body is required"),
    chain: z.string().optional(),
    privateKey: z.string().min(1, "Private key is required"),
});

type UploadFormValues = z.infer<typeof uploadSchema>;

interface UploadCertificateDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function UploadCertificateDialog({ open, onOpenChange }: UploadCertificateDialogProps) {
    const [mode, setMode] = useState<"paste" | "file">("paste");
    const uploadCertificate = useUploadCertificate();

    const form = useForm<UploadFormValues>({
        resolver: zodResolver(uploadSchema),
        defaultValues: { name: "", domainName: "", body: "", chain: "", privateKey: "" },
    });

    const handleClose = (next: boolean) => {
        if (!next) {
            form.reset();
            setMode("paste");
        }
        onOpenChange(next);
    };

    const readFileInto = (field: "body" | "chain" | "privateKey") => async (
        e: React.ChangeEvent<HTMLInputElement>,
    ) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        form.setValue(field, text, { shouldValidate: true });
    };

    const onSubmit = async (values: UploadFormValues) => {
        try {
            await uploadCertificate.mutateAsync({
                name: values.name,
                domainName: values.domainName,
                body: values.body,
                chain: values.chain || undefined,
                privateKey: values.privateKey,
            });
            toast.success("Certificate uploaded", {
                description: `${values.name} (${values.domainName})`,
            });
            form.reset();
            setMode("paste");
            onOpenChange(false);
        } catch (e) {
            toast.error("Upload failed", {
                description: e instanceof Error ? e.message : "Please try again",
            });
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Upload Certificate</DialogTitle>
                    <DialogDescription>
                        Upload a certificate with its private key. Files are encrypted at rest in S3.
                    </DialogDescription>
                </DialogHeader>

                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                            <FormField
                                control={form.control}
                                name="name"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Certificate Name</FormLabel>
                                        <FormControl>
                                            <Input placeholder="My Wildcard Cert" {...field} />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                            <FormField
                                control={form.control}
                                name="domainName"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Domain Name</FormLabel>
                                        <FormControl>
                                            <Input placeholder="*.example.com" {...field} />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                        </div>

                        <Tabs value={mode} onValueChange={(v) => setMode(v as "paste" | "file")}>
                            <TabsList className="w-full">
                                <TabsTrigger value="paste" className="flex-1">
                                    Paste Text
                                </TabsTrigger>
                                <TabsTrigger value="file" className="flex-1">
                                    Upload Files
                                </TabsTrigger>
                            </TabsList>

                            <TabsContent value="paste" className="space-y-4 mt-4">
                                <FormField
                                    control={form.control}
                                    name="body"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Certificate Body (PEM)</FormLabel>
                                            <FormControl>
                                                <Textarea
                                                    placeholder="-----BEGIN CERTIFICATE-----"
                                                    className="font-mono text-xs min-h-[120px]"
                                                    {...field}
                                                />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="chain"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Certificate Chain (PEM, optional)</FormLabel>
                                            <FormControl>
                                                <Textarea
                                                    placeholder="-----BEGIN CERTIFICATE-----"
                                                    className="font-mono text-xs min-h-[80px]"
                                                    {...field}
                                                />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="privateKey"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Private Key (PEM)</FormLabel>
                                            <FormControl>
                                                <Textarea
                                                    placeholder="-----BEGIN PRIVATE KEY-----"
                                                    className="font-mono text-xs min-h-[120px]"
                                                    {...field}
                                                />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                            </TabsContent>

                            <TabsContent value="file" className="space-y-3 mt-4">
                                <p className="text-xs text-muted-foreground">
                                    Selecting a file loads its contents into the form. Switch to
                                    Paste Text to review or edit before uploading.
                                </p>
                                <div>
                                    <Label htmlFor="bodyFile">Certificate Body (.pem, .crt)</Label>
                                    <Input
                                        id="bodyFile"
                                        type="file"
                                        accept=".pem,.crt,.cer,.p7b"
                                        onChange={readFileInto("body")}
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="chainFile">
                                        Certificate Chain (.pem, optional)
                                    </Label>
                                    <Input
                                        id="chainFile"
                                        type="file"
                                        accept=".pem,.crt,.cer,.p7b"
                                        onChange={readFileInto("chain")}
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="keyFile">Private Key (.pem, .key)</Label>
                                    <Input
                                        id="keyFile"
                                        type="file"
                                        accept=".pem,.key"
                                        onChange={readFileInto("privateKey")}
                                    />
                                </div>
                            </TabsContent>
                        </Tabs>

                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => handleClose(false)}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={uploadCertificate.isPending}>
                                {uploadCertificate.isPending ? (
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                ) : (
                                    <Upload className="h-4 w-4 mr-2" />
                                )}
                                Upload
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}

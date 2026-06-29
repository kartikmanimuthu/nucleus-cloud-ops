"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";
import { useUploadVersion } from "@/lib/queries/certificates";

const versionSchema = z.object({
    body: z.string().min(1, "Certificate body is required"),
    chain: z.string().optional(),
    privateKey: z.string().min(1, "Private key is required"),
    activate: z.boolean(),
});

type VersionFormValues = z.infer<typeof versionSchema>;

interface UploadVersionDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    certificateId: string;
}

export function UploadVersionDialog({
    open,
    onOpenChange,
    certificateId,
}: UploadVersionDialogProps) {
    const uploadVersion = useUploadVersion();
    const form = useForm<VersionFormValues>({
        resolver: zodResolver(versionSchema),
        defaultValues: { body: "", chain: "", privateKey: "", activate: false },
    });

    const handleClose = (next: boolean) => {
        if (!next) form.reset();
        onOpenChange(next);
    };

    const onSubmit = async (values: VersionFormValues) => {
        try {
            await uploadVersion.mutateAsync({
                certId: certificateId,
                body: values.body,
                chain: values.chain || undefined,
                privateKey: values.privateKey,
                activate: values.activate,
            });
            toast.success("Version uploaded", {
                description: values.activate ? "Activated." : "Saved (not active).",
            });
            form.reset();
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
                    <DialogTitle>Upload New Version</DialogTitle>
                    <DialogDescription>
                        Paste renewed certificate material. It must match this
                        certificate&apos;s domain and key pair.
                    </DialogDescription>
                </DialogHeader>
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3 py-2">
                        <FormField
                            control={form.control}
                            name="body"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Certificate Body (PEM)</FormLabel>
                                    <FormControl>
                                        <Textarea
                                            rows={4}
                                            placeholder="-----BEGIN CERTIFICATE-----"
                                            className="font-mono text-xs"
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
                                        <Textarea rows={3} className="font-mono text-xs" {...field} />
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
                                            rows={4}
                                            placeholder="-----BEGIN PRIVATE KEY-----"
                                            className="font-mono text-xs"
                                            {...field}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="activate"
                            render={({ field }) => (
                                <FormItem className="flex flex-row items-center gap-2 space-y-0">
                                    <FormControl>
                                        <Checkbox
                                            checked={field.value}
                                            onCheckedChange={field.onChange}
                                        />
                                    </FormControl>
                                    <FormLabel className="font-normal">
                                        Make this version active immediately
                                    </FormLabel>
                                </FormItem>
                            )}
                        />
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => handleClose(false)}
                                disabled={uploadVersion.isPending}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={uploadVersion.isPending}>
                                {uploadVersion.isPending ? (
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                ) : null}
                                Upload
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}

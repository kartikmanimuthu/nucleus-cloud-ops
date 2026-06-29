"use client";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useDeleteCertificate, type CertificateRow } from "@/lib/queries/certificates";

interface DeleteCertificateDialogProps {
    certificate: CertificateRow | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function DeleteCertificateDialog({
    certificate,
    open,
    onOpenChange,
}: DeleteCertificateDialogProps) {
    const deleteCertificate = useDeleteCertificate();

    const handleDelete = async () => {
        if (!certificate) return;
        try {
            await deleteCertificate.mutateAsync(certificate.id);
            toast.success("Certificate deleted", { description: certificate.name });
            onOpenChange(false);
        } catch (e) {
            toast.error("Delete failed", {
                description: e instanceof Error ? e.message : "Network error — please try again",
            });
        }
    };

    if (!certificate) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Delete Certificate</DialogTitle>
                    <DialogDescription>
                        This will permanently delete the certificate &quot;{certificate.name}&quot; (
                        {certificate.domainName}) and all its files from S3. This action cannot be
                        undone.
                    </DialogDescription>
                </DialogHeader>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={deleteCertificate.isPending}
                        onClick={handleDelete}
                    >
                        {deleteCertificate.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                            <Trash2 className="h-4 w-4 mr-2" />
                        )}
                        Delete
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

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
import { Loader2, Trash2 } from "lucide-react";
import type { CertificateRow } from "./certificate-grid";

interface DeleteCertificateDialogProps {
    certificate: CertificateRow | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDeleted: () => void;
}

export function DeleteCertificateDialog({
    certificate,
    open,
    onOpenChange,
    onDeleted,
}: DeleteCertificateDialogProps) {
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState("");

    const handleDelete = async () => {
        if (!certificate) return;
        setError("");
        setDeleting(true);
        try {
            const res = await fetch(`/api/certificates/${certificate.id}`, { method: "DELETE" });
            const json = await res.json();
            if (!json.success) {
                setError(json.error || "Delete failed");
            } else {
                onOpenChange(false);
                onDeleted();
            }
        } catch {
            setError("Network error — please try again");
        } finally {
            setDeleting(false);
        }
    };

    if (!certificate) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Delete Certificate</DialogTitle>
                    <DialogDescription>
                        This will permanently delete the certificate &quot;{certificate.name}&quot;
                        ({certificate.domainName}) and all its files from S3. This action cannot be undone.
                    </DialogDescription>
                </DialogHeader>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button variant="destructive" disabled={deleting} onClick={handleDelete}>
                        {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
                        Delete
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/rbac/gated";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatDate } from "@/lib/date-utils";
import { useTenant } from "@/lib/tenant-context";

const PAGE_SIZE = 10;
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";

interface Invitation {
    id: string;
    tenantId: string;
    email: string;
    role: string;
    invitedBy: string;
    status: "pending" | "accepted" | "revoked" | "expired";
    createdAt: string;
    expiresAt: string;
}

function StatusBadge({ status }: { status: Invitation["status"] }) {
    if (status === "pending") {
        return (
            <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                Pending
            </Badge>
        );
    }
    if (status === "accepted") {
        return (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                Accepted
            </Badge>
        );
    }
    if (status === "expired") {
        return (
            <Badge variant="secondary" className="text-muted-foreground">
                Expired
            </Badge>
        );
    }
    return <Badge variant="secondary">{status}</Badge>;
}

export function InvitationsTable({
    invitations,
    loading,
    error,
    onResend,
    onRevoke,
}: {
    invitations: Invitation[];
    loading: boolean;
    error: string | null;
    onResend: (id: string) => Promise<void>;
    onRevoke: (id: string) => Promise<void>;
}) {
    // cooldowns: Record<invitationId, secondsRemaining>
    const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
    // sentFlash: Record<invitationId, boolean> — shows "Sent" for 2s
    const [sentFlash, setSentFlash] = useState<Record<string, boolean>>({});
    const [revokingId, setRevokingId] = useState<string | null>(null);
    const { timezone } = useTenant();
    const [page, setPage] = useState(0);

    // Reset page when invitations list changes
    useEffect(() => {
        setPage(0);
    }, [invitations.length]);

    // Tick down all active cooldowns every second
    useEffect(() => {
        const ids = Object.keys(cooldowns).filter((id) => cooldowns[id] > 0);
        if (ids.length === 0) return;
        const timer = setInterval(() => {
            setCooldowns((prev) => {
                const next = { ...prev };
                for (const id of ids) {
                    if (next[id] > 0) next[id] -= 1;
                }
                return next;
            });
        }, 1000);
        return () => clearInterval(timer);
    }, [cooldowns]);

    const handleResend = useCallback(
        async (id: string) => {
            await onResend(id);
            // Start cooldown
            setCooldowns((prev) => ({ ...prev, [id]: 60 }));
            // Show "Sent" flash for 2 seconds
            setSentFlash((prev) => ({ ...prev, [id]: true }));
            setTimeout(() => {
                setSentFlash((prev) => ({ ...prev, [id]: false }));
            }, 2000);
        },
        [onResend]
    );

    const handleRevokeConfirm = useCallback(async () => {
        if (!revokingId) return;
        const id = revokingId;
        setRevokingId(null);
        await onRevoke(id);
    }, [revokingId, onRevoke]);

    if (error) {
        return <p className="text-sm text-destructive">{error}</p>;
    }
    if (loading) {
        return <p className="text-muted-foreground text-sm">Loading...</p>;
    }
    if (invitations.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>No pending invitations</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-muted-foreground text-sm">
                        All invitations have been accepted, or none have been sent yet.
                    </p>
                </CardContent>
            </Card>
        );
    }

    const revoking = invitations.find((inv) => inv.id === revokingId);
    const totalPages = Math.ceil(invitations.length / PAGE_SIZE);
    const pagedInvitations = invitations.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    return (
        <TooltipProvider>
            <div className="space-y-2">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Invited</TableHead>
                        <TableHead>Expires</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Actions</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {pagedInvitations.map((inv) => {
                        const cooldown = cooldowns[inv.id] ?? 0;
                        const isFlashing = sentFlash[inv.id] ?? false;
                        const isPending = inv.status === "pending";

                        return (
                            <TableRow key={inv.id}>
                                <TableCell className="font-medium">{inv.email}</TableCell>
                                <TableCell>
                                    <Badge variant="secondary">{inv.role}</Badge>
                                </TableCell>
                                <TableCell className="text-muted-foreground text-sm">
                                    {formatDate(inv.createdAt, 'shortDate', timezone)}
                                </TableCell>
                                <TableCell className="text-muted-foreground text-sm">
                                    {formatDate(inv.expiresAt, 'shortDate', timezone)}
                                </TableCell>
                                <TableCell>
                                    <StatusBadge status={inv.status} />
                                </TableCell>
                                <TableCell>
                                    {isPending && (
                                        <div className="flex items-center gap-2">
                                            {cooldown > 0 ? (
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <span>
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                disabled
                                                            >
                                                                {isFlashing ? "Sent" : "Resend"}
                                                            </Button>
                                                        </span>
                                                    </TooltipTrigger>
                                                    <TooltipContent>
                                                        Resend available in {cooldown}s
                                                    </TooltipContent>
                                                </Tooltip>
                                            ) : (
                                                <GatedButton
                                                    action="update"
                                                    subject="User"
                                                    data={inv as unknown as Record<string, unknown>}
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => handleResend(inv.id)}
                                                >
                                                    Resend
                                                </GatedButton>
                                            )}
                                            <GatedButton
                                                action="delete"
                                                subject="User"
                                                data={inv as unknown as Record<string, unknown>}
                                                variant="ghost"
                                                size="sm"
                                                className="text-destructive hover:text-destructive"
                                                onClick={() => setRevokingId(inv.id)}
                                            >
                                                Revoke
                                            </GatedButton>
                                        </div>
                                    )}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>

            {totalPages > 1 && (
                <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={page === 0}
                        onClick={() => setPage((p) => p - 1)}
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span>
                        Page {page + 1} of {totalPages}
                    </span>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={page >= totalPages - 1}
                        onClick={() => setPage((p) => p + 1)}
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            )}
            </div>

            <AlertDialog open={!!revokingId} onOpenChange={(open) => !open && setRevokingId(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Revoke invitation?</AlertDialogTitle>
                        <AlertDialogDescription>
                            The invitation sent to {revoking?.email} will be cancelled. They won&apos;t be able to use it to join your organization.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep invitation</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={handleRevokeConfirm}
                        >
                            Revoke invitation
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </TooltipProvider>
    );
}

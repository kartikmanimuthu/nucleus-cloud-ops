"use client";

import { useState } from "react";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import { formatDate } from "@/lib/date-utils";
import { useTenant } from "@/lib/tenant-context";
import { Gate, GatedButton } from "@/components/rbac/gated";
import { MemberAttributesDialog } from "./member-attributes-dialog";

const PAGE_SIZE = 10;

interface Member {
    id: string;
    userId: string;
    email: string;
    role: string;
    assignedAt: string;
}

export function MembersTable({
    members,
    loading,
    error,
    currentUserId,
    availableRoles,
    onRoleChange,
}: {
    members: Member[];
    loading: boolean;
    error: string | null;
    currentUserId: string;
    availableRoles: string[];
    onRoleChange: (memberId: string, newRole: string) => Promise<void>;
}) {
    const { timezone } = useTenant();
    const [page, setPage] = useState(0);
    /** Member whose principal attributes are being edited, if any. */
    const [attributesFor, setAttributesFor] = useState<string | null>(null);

    if (error) {
        return <p className="text-sm text-destructive">{error}</p>;
    }
    if (loading) {
        return <p className="text-muted-foreground text-sm">Loading...</p>;
    }
    if (members.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>No other members yet</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-muted-foreground text-sm">
                        Invite your team to start collaborating. They&apos;ll receive an email to set up their account.
                    </p>
                </CardContent>
            </Card>
        );
    }

    const totalPages = Math.ceil(members.length / PAGE_SIZE);
    const pagedMembers = members.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    return (
        <div className="space-y-2">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Joined</TableHead>
                        <TableHead className="w-10 sr-only">Attributes</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {pagedMembers.map((m) => (
                        <TableRow key={m.id}>
                            <TableCell className="font-medium">{m.email}</TableCell>
                            <TableCell>
                                {m.userId === currentUserId ? (
                                    <Badge variant="secondary">{m.role}</Badge>
                                ) : (
                                    <Gate action="update" subject="User" data={m as unknown as Record<string, unknown>}>
                                        {({ allowed, reason }) => (
                                            <Select
                                                disabled={!allowed}
                                                defaultValue={m.role}
                                                onValueChange={(val) => onRoleChange(m.id, val)}
                                            >
                                                <SelectTrigger
                                                    className="h-7 w-32 text-xs"
                                                    title={allowed ? undefined : (reason ?? undefined)}
                                                >
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {availableRoles.map((r) => (
                                                        <SelectItem key={r} value={r} className="text-xs">
                                                            {r}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        )}
                                    </Gate>
                                )}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">
                                {formatDate(m.assignedAt, 'shortDate', timezone)}
                            </TableCell>
                            <TableCell className="text-right">
                                <GatedButton
                                    action="update"
                                    subject="User"
                                    data={m as unknown as Record<string, unknown>}
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    title="Edit attributes"
                                    aria-label={`Edit attributes for ${m.email}`}
                                    onClick={() => setAttributesFor(m.id)}
                                >
                                    <SlidersHorizontal className="h-4 w-4" />
                                </GatedButton>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>

            <MemberAttributesDialog
                memberId={attributesFor}
                open={attributesFor !== null}
                onOpenChange={(open) => !open && setAttributesFor(null)}
            />


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
    );
}

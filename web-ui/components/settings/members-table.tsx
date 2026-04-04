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
import { ChevronLeft, ChevronRight } from "lucide-react";

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
    const [page, setPage] = useState(0);

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
                                    <Select
                                        defaultValue={m.role}
                                        onValueChange={(val) => onRoleChange(m.id, val)}
                                    >
                                        <SelectTrigger className="h-7 w-32 text-xs">
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
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">
                                {new Date(m.assignedAt).toLocaleDateString()}
                            </TableCell>
                        </TableRow>
                    ))}
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
    );
}

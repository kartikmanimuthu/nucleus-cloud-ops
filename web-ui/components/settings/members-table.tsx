"use client";

import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
}: {
    members: Member[];
    loading: boolean;
    error: string | null;
}) {
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
    return (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Joined</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {members.map((m) => (
                    <TableRow key={m.id}>
                        <TableCell className="font-medium">{m.email}</TableCell>
                        <TableCell>
                            <Badge variant="secondary">{m.role}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                            {new Date(m.assignedAt).toLocaleDateString()}
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

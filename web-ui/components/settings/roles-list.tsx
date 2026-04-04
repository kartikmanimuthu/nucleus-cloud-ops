"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2 } from "lucide-react";
import type { PermissionSet, Module } from "@/lib/rbac/types";

interface PredefinedRole {
    id: string;
    name: string;
    permissions: PermissionSet;
    level: number;
}

interface CustomRole {
    id: string;
    name: string;
    permissions: PermissionSet;
    level: number;
    createdBy: string;
}

interface RolesListProps {
    predefinedRoles: PredefinedRole[];
    customRoles: CustomRole[];
    onEdit: (role: CustomRole) => void;
    onDelete: (role: CustomRole) => void;
}

const LEVEL_BADGE: Record<number, "default" | "secondary" | "outline"> = {
    4: "default",
    3: "secondary",
    2: "outline",
    1: "outline",
};

function permissionSummary(permissions: PermissionSet): string {
    const modules = Object.keys(permissions) as Module[];
    const active = modules.filter(
        (m) => permissions[m] && permissions[m].length > 0
    );
    if (active.length === 0) return "No permissions";
    return active.join(", ");
}

function RoleCard({
    role,
    editable,
    onEdit,
    onDelete,
}: {
    role: PredefinedRole | CustomRole;
    editable: boolean;
    onEdit?: () => void;
    onDelete?: () => void;
}) {
    const badgeVariant = LEVEL_BADGE[role.level] ?? "outline";
    const summary = permissionSummary(role.permissions);

    return (
        <Card>
            <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <CardTitle className="text-lg font-semibold">
                            {role.name}
                        </CardTitle>
                        <Badge variant={badgeVariant}>Level {role.level}</Badge>
                    </div>
                    {editable && (
                        <div className="flex items-center gap-1">
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Edit ${role.name}`}
                                onClick={onEdit}
                            >
                                <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Delete ${role.name}`}
                                className="text-destructive hover:text-destructive"
                                onClick={onDelete}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                    )}
                </div>
            </CardHeader>
            <CardContent>
                <p className="text-sm text-muted-foreground">{summary}</p>
            </CardContent>
        </Card>
    );
}

export function RolesList({
    predefinedRoles,
    customRoles,
    onEdit,
    onDelete,
}: RolesListProps) {
    return (
        <div className="space-y-8">
            <div className="space-y-3">
                <h3 className="text-lg font-semibold">Predefined Roles</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                    {predefinedRoles.map((role) => (
                        <RoleCard key={role.id} role={role} editable={false} />
                    ))}
                </div>
            </div>

            {customRoles.length > 0 && (
                <div className="space-y-3">
                    <h3 className="text-lg font-semibold">Custom Roles</h3>
                    <div className="grid gap-3 sm:grid-cols-2">
                        {customRoles.map((role) => (
                            <RoleCard
                                key={role.id}
                                role={role}
                                editable={true}
                                onEdit={() => onEdit(role)}
                                onDelete={() => onDelete(role)}
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Shield, Plus } from "lucide-react";
import { RolesList } from "@/components/settings/roles-list";
import { RoleDialog } from "@/components/settings/role-dialog";
import { DeleteRoleDialog } from "@/components/settings/delete-role-dialog";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PermissionSet } from "@/lib/rbac/types";
import {
    useRoles,
    useSaveRole,
    useDeleteRole,
    type CustomRole,
} from "@/lib/queries/roles";

export default function RolesPage() {
    const rolesQuery = useRoles();
    const saveRole = useSaveRole();
    const deleteRole = useDeleteRole();

    const predefinedRoles = rolesQuery.data?.predefined ?? [];
    const customRoles = rolesQuery.data?.custom ?? [];
    const loading = rolesQuery.isLoading;
    const error = rolesQuery.error
        ? rolesQuery.error instanceof Error
            ? rolesQuery.error.message
            : "Failed to load roles."
        : null;

    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingRole, setEditingRole] = useState<CustomRole | null>(null);

    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [deletingRole, setDeletingRole] = useState<CustomRole | null>(null);

    const handleCreateClick = () => {
        setEditingRole(null);
        setDialogOpen(true);
    };

    const handleEdit = (role: CustomRole) => {
        setEditingRole(role);
        setDialogOpen(true);
    };

    const handleDelete = (role: CustomRole) => {
        setDeletingRole(role);
        setDeleteDialogOpen(true);
    };

    const handleSave = async (name: string, permissions: PermissionSet) => {
        // mutateAsync throws on failure so the dialog can surface the error.
        await saveRole.mutateAsync({ id: editingRole?.id, name, permissions });
        setDialogOpen(false);
    };

    const handleConfirmDelete = async () => {
        if (!deletingRole) return;
        await deleteRole.mutateAsync(deletingRole.id);
        setDeleteDialogOpen(false);
        setDeletingRole(null);
    };

    const atLimit = customRoles.length >= 10;

    return (
        <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 bg-background">
            <div className="flex items-center justify-between">
                <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                        <Shield className="h-6 w-6" />
                        <h2 className="text-3xl font-bold tracking-tight text-foreground">
                            Roles
                        </h2>
                    </div>
                    <p className="text-muted-foreground">
                        Manage predefined and custom roles for your organization.
                    </p>
                </div>

                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span>
                                <Button
                                    onClick={handleCreateClick}
                                    disabled={atLimit}
                                >
                                    <Plus className="mr-2 h-4 w-4" />
                                    Create Role
                                </Button>
                            </span>
                        </TooltipTrigger>
                        {atLimit && (
                            <TooltipContent>
                                Maximum 10 custom roles reached
                            </TooltipContent>
                        )}
                    </Tooltip>
                </TooltipProvider>
            </div>

            {error && (
                <p className="text-sm text-destructive">{error}</p>
            )}

            {loading ? (
                <p className="text-muted-foreground text-sm">Loading roles...</p>
            ) : (
                <>
                    {customRoles.length === 0 && (
                        <Card>
                            <CardHeader>
                                <CardTitle>No custom roles yet</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-muted-foreground text-sm">
                                    Create a custom role to define a specific permission set for your team members.
                                </p>
                            </CardContent>
                        </Card>
                    )}
                    <RolesList
                        predefinedRoles={predefinedRoles}
                        customRoles={customRoles}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                    />
                </>
            )}

            <RoleDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                role={editingRole}
                onSave={handleSave}
            />

            <DeleteRoleDialog
                open={deleteDialogOpen}
                onOpenChange={setDeleteDialogOpen}
                roleName={deletingRole?.name ?? ""}
                onConfirm={handleConfirmDelete}
            />
        </div>
    );
}

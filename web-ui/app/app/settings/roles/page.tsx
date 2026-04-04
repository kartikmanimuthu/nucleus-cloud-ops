"use client";

import { useState, useEffect, useCallback } from "react";
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

interface PredefinedRole {
    id: string;
    name: string;
    permissions: PermissionSet;
    level: number;
    predefined: true;
}

interface CustomRole {
    id: string;
    tenantId: string;
    name: string;
    permissions: PermissionSet;
    level: number;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
}

export default function RolesPage() {
    const [predefinedRoles, setPredefinedRoles] = useState<PredefinedRole[]>([]);
    const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingRole, setEditingRole] = useState<CustomRole | null>(null);

    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [deletingRole, setDeletingRole] = useState<CustomRole | null>(null);

    const fetchRoles = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/settings/roles");
            const json = await res.json();
            if (!res.ok || !json.success) {
                setError(json.error ?? "Failed to load roles.");
                return;
            }
            setPredefinedRoles(json.data.predefined ?? []);
            setCustomRoles(json.data.custom ?? []);
        } catch {
            setError("Failed to load roles.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchRoles();
    }, [fetchRoles]);

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
        if (editingRole) {
            const res = await fetch(`/api/settings/roles/${editingRole.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, permissions }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error ?? "Failed to update role.");
            }
        } else {
            const res = await fetch("/api/settings/roles", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, permissions }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error ?? "Failed to create role.");
            }
        }
        setDialogOpen(false);
        await fetchRoles();
    };

    const handleConfirmDelete = async () => {
        if (!deletingRole) return;
        const res = await fetch(`/api/settings/roles/${deletingRole.id}`, {
            method: "DELETE",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
            throw new Error(json.error ?? "Failed to delete role.");
        }
        setDeleteDialogOpen(false);
        setDeletingRole(null);
        await fetchRoles();
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

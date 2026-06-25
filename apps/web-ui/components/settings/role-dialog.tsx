"use client";

import { useState, useEffect } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import type { Module, Action, PermissionSet } from "@/lib/rbac/types";

const MODULES: { key: Module; label: string }[] = [
    { key: "Accounts", label: "Accounts" },
    { key: "Schedules", label: "Schedules" },
    { key: "AIOps", label: "AI Ops" },
    { key: "Inventory", label: "Inventory" },
    { key: "Settings", label: "Settings" },
];

const ACTIONS: { key: Action; label: string }[] = [
    { key: "create", label: "Create" },
    { key: "read", label: "Read" },
    { key: "update", label: "Update" },
    { key: "delete", label: "Delete" },
];

type PermissionsState = Record<Module, Set<Action>>;

function toPermissionsState(permissions?: PermissionSet | null): PermissionsState {
    const state = {} as PermissionsState;
    for (const mod of MODULES) {
        state[mod.key] = new Set((permissions?.[mod.key] ?? []) as Action[]);
    }
    return state;
}

function toPermissionSet(state: PermissionsState): PermissionSet {
    const result = {} as PermissionSet;
    for (const mod of MODULES) {
        result[mod.key] = Array.from(state[mod.key]) as Action[];
    }
    return result;
}

function hasAnyPermission(state: PermissionsState): boolean {
    return MODULES.some((m) => state[m.key].size > 0);
}

interface RoleDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    role?: { id: string; name: string; permissions: PermissionSet } | null;
    onSave: (name: string, permissions: PermissionSet) => Promise<void>;
}

export function RoleDialog({ open, onOpenChange, role, onSave }: RoleDialogProps) {
    const [name, setName] = useState("");
    const [permissions, setPermissions] = useState<PermissionsState>(
        toPermissionsState(null)
    );
    const [saving, setSaving] = useState(false);
    const [nameError, setNameError] = useState<string | null>(null);
    const [permError, setPermError] = useState<string | null>(null);

    // Reset form when dialog opens or role changes
    useEffect(() => {
        if (open) {
            setName(role?.name ?? "");
            setPermissions(toPermissionsState(role?.permissions ?? null));
            setNameError(null);
            setPermError(null);
            setSaving(false);
        }
    }, [open, role]);

    function togglePermission(module: Module, action: Action) {
        setPermissions((prev) => {
            const next = { ...prev };
            const actions = new Set(next[module]);
            if (actions.has(action)) {
                actions.delete(action);
                // Rule 2: unchecking Read clears all actions for this module
                if (action === "read") {
                    actions.clear();
                }
            } else {
                actions.add(action);
                // Rule 1: checking C/U/D auto-checks Read
                if (action !== "read") {
                    actions.add("read");
                }
            }
            next[module] = actions;
            return next;
        });
        setPermError(null);
    }

    async function handleSave() {
        let valid = true;
        if (!name.trim()) {
            setNameError("Role name is required.");
            valid = false;
        } else {
            setNameError(null);
        }
        if (!hasAnyPermission(permissions)) {
            setPermError("At least one permission must be selected.");
            valid = false;
        } else {
            setPermError(null);
        }
        if (!valid) return;

        setSaving(true);
        try {
            await onSave(name.trim(), toPermissionSet(permissions));
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Failed to save role.";
            // Surface name-conflict errors under the name field
            if (message.toLowerCase().includes("already exists") || message.toLowerCase().includes("name")) {
                setNameError(message);
            } else {
                setNameError(message);
            }
        } finally {
            setSaving(false);
        }
    }

    const isValid = name.trim().length > 0 && hasAnyPermission(permissions);
    const title = role ? `Edit Role: ${role.name}` : "Create Custom Role";

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="space-y-1.5">
                        <Label htmlFor="role-name">Role Name</Label>
                        <Input
                            id="role-name"
                            placeholder="e.g., DevOps Lead"
                            maxLength={50}
                            value={name}
                            onChange={(e) => {
                                setName(e.target.value);
                                setNameError(null);
                            }}
                        />
                        {nameError && (
                            <p className="text-sm text-destructive">{nameError}</p>
                        )}
                    </div>

                    <div className="space-y-1.5">
                        <Label>Permissions</Label>
                        <div className="rounded-md border">
                            <Table>
                                <TableHeader>
                                    <TableRow className="bg-muted/50">
                                        <TableHead className="w-32">Module</TableHead>
                                        {ACTIONS.map((a) => (
                                            <TableHead key={a.key} className="text-center w-20">
                                                {a.label}
                                            </TableHead>
                                        ))}
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {MODULES.map((mod) => (
                                        <TableRow key={mod.key} className="min-h-[44px]">
                                            <TableCell className="font-medium py-3">
                                                {mod.label}
                                            </TableCell>
                                            {ACTIONS.map((act) => (
                                                <TableCell
                                                    key={act.key}
                                                    className="text-center py-3"
                                                >
                                                    <Checkbox
                                                        checked={permissions[mod.key].has(act.key)}
                                                        onCheckedChange={() =>
                                                            togglePermission(mod.key, act.key)
                                                        }
                                                        aria-label={`${mod.label} ${act.label}`}
                                                    />
                                                </TableCell>
                                            ))}
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                        {permError && (
                            <p className="text-sm text-destructive">{permError}</p>
                        )}
                    </div>
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={saving}
                    >
                        Discard Changes
                    </Button>
                    <Button onClick={handleSave} disabled={!isValid || saving}>
                        {saving ? "Saving..." : "Save Role"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

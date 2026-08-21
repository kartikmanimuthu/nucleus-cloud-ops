"use client";

import { useState } from "react";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { GatedButton, GatedDropdownItem } from "@/components/rbac/gated";
import {
  useAdminRegistry,
  useDeletePermission,
  RegistryRequestError,
  type AdminActionRow,
} from "@/lib/queries/rbac-registry";

import { PermissionDialog } from "./permission-dialog";

function sortActions(actions: AdminActionRow[]): AdminActionRow[] {
  return [...actions].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
}

export function PermissionsTab() {
  const { data, isLoading, error } = useAdminRegistry();
  const deletePermission = useDeletePermission();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPermission, setEditingPermission] = useState<AdminActionRow | null>(null);
  const [deletingPermission, setDeletingPermission] = useState<AdminActionRow | null>(null);

  function openCreate() {
    setEditingPermission(null);
    setDialogOpen(true);
  }

  function openEdit(permission: AdminActionRow) {
    setEditingPermission(permission);
    setDialogOpen(true);
  }

  async function confirmDelete() {
    if (!deletingPermission) return;
    const target = deletingPermission;
    try {
      await deletePermission.mutateAsync({ id: target.id });
      toast.success(`Deleted '${target.label}'.`);
      setDeletingPermission(null);
    } catch (err) {
      // Branch on status/isConfirmable if ever needed, never on message text
      // (it has already been reworded once). Here the message is only ever
      // surfaced to the user, not used for control flow.
      const message =
        err instanceof RegistryRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to delete the permission.";
      toast.error(message);
    }
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {error instanceof Error ? error.message : "Failed to load the permission registry."}
        </AlertDescription>
      </Alert>
    );
  }

  const actions = data ? sortActions(data.actions) : [];

  return (
    <TooltipProvider>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Permissions</CardTitle>
          <GatedButton action="update" subject="IAM" size="sm" onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            New permission
          </GatedButton>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A permission becomes grantable when a module lists it. Verbs already defined but unused by any
            module show 0 grants.
          </p>

          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Spinner size="lg" label="Loading permissions" />
            </div>
          ) : actions.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No permissions have been defined yet.
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Permission</TableHead>
                    <TableHead>Behaves as</TableHead>
                    <TableHead>Dangerous</TableHead>
                    <TableHead>In use</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {actions.map((permission) => (
                    <PermissionRow
                      key={permission.id}
                      permission={permission}
                      onEdit={() => openEdit(permission)}
                      onDelete={() => setDeletingPermission(permission)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <PermissionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        permission={editingPermission}
        actions={actions}
      />

      <AlertDialog open={!!deletingPermission} onOpenChange={(open) => !open && setDeletingPermission(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &apos;{deletingPermission?.label}&apos;?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the permission from every module it is listed on. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePermission.isPending}>Keep permission</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deletePermission.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletePermission.isPending ? "Deleting..." : "Delete permission"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

function PermissionRow({
  permission,
  onEdit,
  onDelete,
}: {
  permission: AdminActionRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const inUse = permission.ruleCount > 0;

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <span className="font-medium">{permission.label}</span>
          <code className="w-fit rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {permission.key}
          </code>
        </div>
      </TableCell>
      <TableCell>
        {permission.aliasOfKey ? (
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{permission.aliasOfKey}</code>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {permission.isDangerous ? (
          <Badge variant="destructive">Dangerous</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{permission.ruleCount} grants</TableCell>
      <TableCell>
        <Badge variant={permission.isGlobal ? "secondary" : "outline"}>
          {permission.isGlobal ? "Built-in" : "Custom"}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        {permission.isGlobal ? (
          // Built-in rows have no destructive actions at all — the Edit
          // affordance stays visible but disabled, with the reason in a
          // tooltip, per the project's disable-over-hide convention
          // (components/rbac/gated.tsx). Clicking it still opens the dialog,
          // which renders as a read-only view rather than a form.
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button variant="ghost" size="icon" onClick={onEdit} aria-label={`View ${permission.label}`}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Built-in permission — view only, cannot be edited or deleted</TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-8 w-8 p-0" aria-label={`Actions for ${permission.label}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[180px]">
              <GatedDropdownItem
                action="update"
                subject="IAM"
                data={permission as unknown as Record<string, unknown>}
                className="cursor-pointer"
                onClick={onEdit}
              >
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </GatedDropdownItem>
              {/*
                Disabled + native `title` (not a Radix Tooltip) when in use —
                the same reasoning gated.tsx uses for a denied item: an extra
                wrapper element around a DropdownMenuItem breaks roving-focus
                keyboard navigation. The API refuses this delete anyway; this
                only saves the round trip and explains why up front.
              */}
              <GatedDropdownItem
                action="delete"
                subject="IAM"
                data={permission as unknown as Record<string, unknown>}
                className="cursor-pointer text-destructive data-[disabled]:cursor-not-allowed"
                disabled={inUse}
                title={inUse ? `${permission.ruleCount} roles grant this permission` : undefined}
                onClick={inUse ? undefined : onDelete}
                onSelect={inUse ? (e) => e.preventDefault() : undefined}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </GatedDropdownItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

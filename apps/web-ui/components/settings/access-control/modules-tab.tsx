"use client";

import { useState } from "react";
import * as LucideIcons from "lucide-react";
import type { LucideIcon } from "lucide-react";
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
  useDeleteModule,
  RegistryRequestError,
  type AdminModuleRow,
} from "@/lib/queries/rbac-registry";

import { ModuleDialog } from "./module-dialog";

/**
 * `icon` is stored as a free-text name (e.g. 'dollar-sign' or 'DollarSign').
 *
 * This MUST resolve against `lucide-react`'s `icons` map, not the package
 * namespace. The namespace also exports non-icon PascalCase members —
 * `Icon` (the generic factory) and `createLucideIcon` chief among them —
 * and both pass a `key in namespace` check. `toPascalCase('icon')` produces
 * exactly `'Icon'`, so casting the whole namespace and rendering whatever
 * it returns meant a tenant admin typo (icon name 'icon') rendered lucide's
 * factory component with no `iconNode` prop, crashing the Modules tab for
 * every viewer in the tenant — `module.icon` is persisted, tenant-wide data.
 * `icons` (verified against the installed 0.454.0 runtime: 1534 entries,
 * `'Icon' in icons` and `'createLucideIcon' in icons` both false) contains
 * only real icon components, so that class of collision cannot recur here.
 *
 * The lookup stays defensive on top of that narrower map anyway: persisted
 * data driving a component render deserves a runtime guard even once the
 * map is known-clean, in case a future lucide-react version's `icons`
 * export ever stops being exhaustive or disappears.
 */
const iconMap = (LucideIcons as { icons?: Record<string, LucideIcon> }).icons;

function toPascalCase(input: string): string {
  return input
    .replace(/[-_\s]+(.)/g, (_match, chr: string) => chr.toUpperCase())
    .replace(/^[a-z]/, (chr) => chr.toUpperCase());
}

function resolveModuleIcon(name: string | null): LucideIcon | null {
  if (!name || !iconMap) return null;
  const candidate = iconMap[toPascalCase(name)];
  // `candidate` is typed as always-present because `Record<string, LucideIcon>`
  // claims every string key resolves — it does not, at runtime, for a name
  // with no matching icon. The typeof guard is the real check; never trust
  // the lookup result into a render without it.
  return candidate && typeof candidate === "object" ? candidate : null;
}

function sortModules(modules: AdminModuleRow[]): AdminModuleRow[] {
  return [...modules].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
}

export function ModulesTab() {
  const { data, isLoading, error } = useAdminRegistry();
  const deleteModule = useDeleteModule();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingModule, setEditingModule] = useState<AdminModuleRow | null>(null);
  const [deletingModule, setDeletingModule] = useState<AdminModuleRow | null>(null);

  function openCreate() {
    setEditingModule(null);
    setDialogOpen(true);
  }

  function openEdit(module: AdminModuleRow) {
    setEditingModule(module);
    setDialogOpen(true);
  }

  async function confirmDelete() {
    if (!deletingModule) return;
    const target = deletingModule;
    try {
      await deleteModule.mutateAsync({ id: target.id });
      toast.success(`Deleted '${target.label}'.`);
      setDeletingModule(null);
    } catch (err) {
      // Branch on status/isConfirmable if ever needed, never on message text
      // (it has already been reworded once). Here the message is only ever
      // surfaced to the user, not used for control flow.
      const message =
        err instanceof RegistryRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to delete the module.";
      toast.error(message);
    }
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {error instanceof Error ? error.message : "Failed to load the module registry."}
        </AlertDescription>
      </Alert>
    );
  }

  const modules = data ? sortModules(data.modules) : [];
  const totalActions = data?.actions.length ?? 0;

  return (
    <TooltipProvider>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Modules</CardTitle>
          <GatedButton action="update" subject="IAM" size="sm" onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            New module
          </GatedButton>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A module is a row of the role grid. It only enforces access for the guarded areas mapped to it — a
            module with no areas can be granted but checks nothing.
          </p>

          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Spinner size="lg" label="Loading modules" />
            </div>
          ) : modules.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No modules have been defined yet.</p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Module</TableHead>
                    <TableHead>Permissions</TableHead>
                    <TableHead>Areas</TableHead>
                    <TableHead>Nav path</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>In use</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modules.map((module) => (
                    <ModuleRow
                      key={module.id}
                      module={module}
                      totalActions={totalActions}
                      onEdit={() => openEdit(module)}
                      onDelete={() => setDeletingModule(module)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {data && <ModuleDialog open={dialogOpen} onOpenChange={setDialogOpen} module={editingModule} registry={data} />}

      <AlertDialog open={!!deletingModule} onOpenChange={(open) => !open && setDeletingModule(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &apos;{deletingModule?.label}&apos;?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the module from the role grid. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteModule.isPending}>Keep module</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteModule.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteModule.isPending ? "Deleting..." : "Delete module"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

function ModuleRow({
  module,
  totalActions,
  onEdit,
  onDelete,
}: {
  module: AdminModuleRow;
  totalActions: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const Icon = resolveModuleIcon(module.icon);

  const deleteReasons: string[] = [];
  if (module.subjectKeys.length > 0) deleteReasons.push(`covers ${module.subjectKeys.length} area(s)`);
  if (module.ruleCount > 0) deleteReasons.push(`is granted by ${module.ruleCount} rule(s)`);
  const deleteBlocked = deleteReasons.length > 0;

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          {Icon ? (
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : module.icon ? (
            <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {module.icon}
            </code>
          ) : null}
          <div className="flex flex-col">
            <span className="font-medium">{module.label}</span>
            <code className="w-fit rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{module.key}</code>
          </div>
        </div>
      </TableCell>
      <TableCell className="text-sm">
        {module.actionKeys.length} of {totalActions}
      </TableCell>
      <TableCell className="text-sm">
        {module.subjectKeys.length === 0 ? (
          <span className="text-warning">⚠ none</span>
        ) : (
          module.subjectKeys.length
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{module.navPath ?? "—"}</TableCell>
      <TableCell>
        <Badge variant={module.enabled ? "default" : "secondary"}>{module.enabled ? "Enabled" : "Disabled"}</Badge>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{module.ruleCount} grants</TableCell>
      <TableCell>
        <Badge variant={module.isGlobal ? "secondary" : "outline"}>{module.isGlobal ? "Built-in" : "Custom"}</Badge>
      </TableCell>
      <TableCell className="text-right">
        {module.isGlobal ? (
          // RULING (human partner, overrides the brief): disable-with-tooltip,
          // not hide — a control that vanishes gives the operator nothing to
          // act on, whereas a disabled one explains why (components/rbac/gated.tsx).
          <div className="flex justify-end gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button variant="ghost" size="icon" onClick={onEdit} aria-label={`View ${module.label}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Built-in module — view only, cannot be edited</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button variant="ghost" size="icon" disabled aria-label={`Delete ${module.label}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Built-in module — the compiler resolves grants by row id, so it cannot be deleted. Disable it
                instead; a disabled module contributes nothing without destroying its grants.
              </TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-8 w-8 p-0" aria-label={`Actions for ${module.label}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[200px]">
              <GatedDropdownItem
                action="update"
                subject="IAM"
                data={module as unknown as Record<string, unknown>}
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
                data={module as unknown as Record<string, unknown>}
                className="cursor-pointer text-destructive data-[disabled]:cursor-not-allowed"
                disabled={deleteBlocked}
                title={deleteBlocked ? `Cannot delete — ${deleteReasons.join(" and ")}.` : undefined}
                onClick={deleteBlocked ? undefined : onDelete}
                onSelect={deleteBlocked ? (e) => e.preventDefault() : undefined}
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

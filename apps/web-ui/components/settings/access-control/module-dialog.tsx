"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AlertTriangle, ShieldAlert } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  useCreateModule,
  useUpdateModule,
  RegistryRequestError,
  type AdminModuleRow,
  type AdminRegistry,
  type AdminSubjectRow,
  type ModuleFormInput,
} from "@/lib/queries/rbac-registry";

/**
 * `key` mirrors the server's MODULE_KEY_PATTERN (registry-admin-writes.ts) —
 * PascalCase, unlike a permission's lowercase key, because module keys are
 * also the identifiers seeded modules have always used ('Schedule',
 * 'SpotGuard', ...).
 */
const schema = z.object({
  key: z
    .string()
    .min(1, "A key is required.")
    .regex(/^[A-Za-z][A-Za-z0-9]*$/, "Letters and digits only, e.g. 'CostControl'."),
  label: z.string().trim().min(1, "A label is required."),
  description: z.string().optional(),
  icon: z.string().optional(),
  navPath: z.string().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999),
  enabled: z.boolean(),
  actionKeys: z.array(z.string()).min(1, "Select at least one permission."),
  subjectKeys: z.array(z.string()),
});

type FormValues = z.infer<typeof schema>;

interface PendingForce {
  values: FormValues;
  message: string;
}

export function ModuleDialog({
  open,
  onOpenChange,
  module,
  registry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  module: AdminModuleRow | null;
  registry: AdminRegistry;
}) {
  const create = useCreateModule();
  const update = useUpdateModule();
  const isEdit = Boolean(module);
  // RULING (human partner, overrides the brief): a built-in row is not
  // editable at all. The compiler resolves grants by row ID — a tenant-side
  // override would carry a NEW id no existing rule points at, and
  // mergeByKey() drops the shadowed global row from the snapshot the
  // compiler reads, so every grant on this module would silently stop
  // compiling for every role in the tenant. The API backs this with a 403;
  // this view is the honest front door for that refusal, not a decoration.
  const readOnly = Boolean(module?.isGlobal);

  const [pendingForce, setPendingForce] = useState<PendingForce | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      key: "",
      label: "",
      description: "",
      icon: "",
      navPath: "",
      sortOrder: 100,
      enabled: true,
      actionKeys: [],
      subjectKeys: [],
    },
  });

  useEffect(() => {
    if (!open) {
      setPendingForce(null);
      return;
    }
    form.reset({
      key: module?.key ?? "",
      label: module?.label ?? "",
      description: module?.description ?? "",
      icon: module?.icon ?? "",
      navPath: module?.navPath ?? "",
      sortOrder: module?.sortOrder ?? 100,
      enabled: module?.enabled ?? true,
      actionKeys: module?.actionKeys ?? [],
      subjectKeys: module?.subjectKeys ?? [],
    });
  }, [open, module, form]);

  const watchedActionKeys = form.watch("actionKeys") ?? [];
  const watchedSubjectKeys = form.watch("subjectKeys") ?? [];

  function toggleAction(key: string, checked: boolean) {
    const next = checked ? [...watchedActionKeys, key] : watchedActionKeys.filter((k) => k !== key);
    form.setValue("actionKeys", next, { shouldDirty: true, shouldValidate: true });
  }

  function toggleSubject(key: string, checked: boolean) {
    const next = checked ? [...watchedSubjectKeys, key] : watchedSubjectKeys.filter((k) => k !== key);
    form.setValue("subjectKeys", next, { shouldDirty: true });
  }

  // A module with no areas compiles to zero CASL rules: its checkboxes would
  // tick, save, and grant nothing. Warn rather than block — a module may be
  // created ahead of the areas that will move into it.
  const inert = watchedSubjectKeys.length === 0;

  // Moving an area out of its current module revokes it from every role
  // holding only that module's grant. The API materializes explicit
  // subject-level rules so nobody loses access, and reports how many it
  // wrote — this list is what the toast count is about, ahead of time.
  const moving = watchedSubjectKeys.reduce<AdminSubjectRow[]>((acc, key) => {
    const subject = registry.subjects.find((s) => s.key === key);
    if (subject && subject.moduleKey && subject.moduleKey !== module?.key) acc.push(subject);
    return acc;
  }, []);

  async function performSave(values: FormValues, force: boolean) {
    const payload: ModuleFormInput = {
      key: values.key.trim(),
      label: values.label.trim(),
      description: values.description?.trim() || null,
      icon: values.icon?.trim() || null,
      navPath: values.navPath?.trim() || null,
      sortOrder: values.sortOrder,
      enabled: values.enabled,
      actionKeys: values.actionKeys,
      subjectKeys: values.subjectKeys,
      force,
    };
    try {
      const result = module
        ? await update.mutateAsync({ id: module.id, ...payload })
        : await create.mutateAsync(payload);
      const notes = [
        result.materializedRules > 0 && `${result.materializedRules} grant(s) preserved`,
        result.revokedRules > 0 && `${result.revokedRules} grant(s) revoked`,
      ].filter(Boolean);
      toast.success(`Saved '${values.label}'.${notes.length ? ` ${notes.join(", ")}.` : ""}`);
      setPendingForce(null);
      onOpenChange(false);
    } catch (error) {
      // Branch on isConfirmable (a 409), never on message text — it has
      // already been reworded once mid-project and a status check cannot rot
      // that way. The API refuses removing a still-granted cell because
      // `grantable: false` does not stop an existing rule compiling; it
      // offers to proceed if the operator confirms revoking those grants.
      if (error instanceof RegistryRequestError && error.isConfirmable && !force) {
        setPendingForce({ values, message: error.message });
        return;
      }
      const message =
        error instanceof RegistryRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to save the module.";
      toast.error(message);
    }
  }

  function onSubmit(values: FormValues) {
    return performSave(values, false);
  }

  function confirmForce() {
    if (!pendingForce) return;
    // Re-submits the IDENTICAL payload, only with force added — never sent
    // pre-emptively, only after this explicit confirmation.
    return performSave(pendingForce.values, true);
  }

  const saving = create.isPending || update.isPending;

  if (readOnly && module) {
    const grantedActions = registry.actions.filter((a) => module.actionKeys.includes(a.key));
    const coveredSubjects = registry.subjects.filter((s) => module.subjectKeys.includes(s.key));

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{module.label}</DialogTitle>
            <DialogDescription>
              A module is a row of the role grid — a label and a grouping for the permissions and guarded areas
              beneath it.
            </DialogDescription>
          </DialogHeader>

          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Built-in module — read only</AlertTitle>
            <AlertDescription>
              The compiler resolves grants by row id. Editing this row would give it a new id that no existing
              rule points at, silently revoking every grant on it for every role in the tenant. Create your own
              module instead if you need something different.
            </AlertDescription>
          </Alert>

          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Key</dt>
              <dd>
                <code className="rounded bg-muted px-1.5 py-0.5">{module.key}</code>
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Description</dt>
              <dd>{module.description ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Icon</dt>
              <dd>{module.icon ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Nav path</dt>
              <dd>{module.navPath ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <Badge variant={module.enabled ? "default" : "secondary"}>
                  {module.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="shrink-0 text-muted-foreground">Permissions</dt>
              <dd className="text-right">
                {grantedActions.length > 0 ? grantedActions.map((a) => a.label).join(", ") : "—"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="shrink-0 text-muted-foreground">Areas</dt>
              <dd className="text-right">
                {coveredSubjects.length > 0 ? coveredSubjects.map((s) => s.label).join(", ") : "—"}
              </dd>
            </div>
          </dl>

          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const grantableActions = registry.actions.filter((a) => !a.aliasOfKey);
  const ordinarySubjects = registry.subjects.filter((s) => s.kind !== "capability");
  const capabilitySubjects = registry.subjects.filter((s) => s.kind === "capability");

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{isEdit ? `Edit ${module?.label}` : "New module"}</DialogTitle>
            <DialogDescription>
              A module is a row of the role grid. It only enforces access for the areas mapped to it below — a
              module with none can be granted but checks nothing.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="module-key">Key</Label>
                  <Input id="module-key" {...form.register("key")} placeholder="CostControl" />
                  {form.formState.errors.key && (
                    <p className="text-xs text-destructive">{form.formState.errors.key.message}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="module-label">Label</Label>
                  <Input id="module-label" {...form.register("label")} placeholder="Cost Control" />
                  {form.formState.errors.label && (
                    <p className="text-xs text-destructive">{form.formState.errors.label.message}</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="module-desc">Description</Label>
                <Input id="module-desc" {...form.register("description")} placeholder="Shown in the module list" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="module-icon">Icon</Label>
                  <Input id="module-icon" {...form.register("icon")} placeholder="dollar-sign" />
                  <p className="text-xs text-muted-foreground">Optional lucide icon name.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="module-nav">Nav path</Label>
                  <Input id="module-nav" {...form.register("navPath")} placeholder="/app/cost-control" />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <Label htmlFor="module-order">Row order</Label>
                  <Input id="module-order" type="number" {...form.register("sortOrder")} className="w-28" />
                  {form.formState.errors.sortOrder && (
                    <p className="text-xs text-destructive">{form.formState.errors.sortOrder.message}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="module-enabled"
                    checked={form.watch("enabled")}
                    onCheckedChange={(checked) => form.setValue("enabled", checked, { shouldDirty: true })}
                  />
                  <Label htmlFor="module-enabled" className="font-normal">
                    Enabled
                  </Label>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Permissions that apply</Label>
              <p className="text-xs text-muted-foreground">
                Verbs that become grantable cells on this module&apos;s row. Aliases are excluded — they resolve
                to their target column at compile time, so a column here would duplicate it.
              </p>
              <ScrollArea className="h-40 rounded-md border p-3">
                <div className="space-y-2">
                  {grantableActions.map((action) => (
                    <div key={action.key} className="flex items-center gap-2">
                      <Checkbox
                        id={`module-action-${action.key}`}
                        checked={watchedActionKeys.includes(action.key)}
                        onCheckedChange={(checked) => toggleAction(action.key, checked === true)}
                      />
                      <Label htmlFor={`module-action-${action.key}`} className="font-normal">
                        {action.label}
                      </Label>
                    </div>
                  ))}
                </div>
              </ScrollArea>
              {form.formState.errors.actionKeys && (
                <p className="text-xs text-destructive">{form.formState.errors.actionKeys.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Areas this module covers</Label>
              <p className="text-xs text-muted-foreground">
                The guarded subjects the compiler actually checks. A module with none is grantable but enforces
                nothing.
              </p>
              <ScrollArea className="h-48 rounded-md border p-3">
                <div className="space-y-3">
                  <div className="space-y-2">
                    {ordinarySubjects.map((subject) => (
                      <SubjectCheckbox
                        key={subject.key}
                        subject={subject}
                        module={module}
                        checked={watchedSubjectKeys.includes(subject.key)}
                        onToggle={toggleSubject}
                      />
                    ))}
                  </div>
                  {capabilitySubjects.length > 0 && (
                    <div className="space-y-2 border-t pt-3">
                      <p className="text-xs font-semibold text-muted-foreground">Agent capabilities</p>
                      {capabilitySubjects.map((subject) => (
                        <SubjectCheckbox
                          key={subject.key}
                          subject={subject}
                          module={module}
                          checked={watchedSubjectKeys.includes(subject.key)}
                          onToggle={toggleSubject}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>

            {inert && (
              <Alert className="border-warning/50 bg-warning/10 text-warning [&>svg]:text-warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>No areas selected</AlertTitle>
                <AlertDescription>
                  Roles can be granted this module, but nothing is enforced until an area is moved into it.
                </AlertDescription>
              </Alert>
            )}

            {moving.length > 0 && (
              <Alert className="border-warning/50 bg-warning/10 text-warning [&>svg]:text-warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>This moves areas out of their current module</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {moving.map((subject) => (
                      <li key={subject.key}>
                        {subject.label} — currently in{" "}
                        <code className="rounded bg-muted px-1 py-0.5">{subject.moduleKey}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2">
                    Existing grants are preserved automatically — an explicit rule is written for each role that
                    would otherwise lose access.
                  </p>
                </AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Spinner className="mr-2 h-4 w-4" />}
                {isEdit ? "Save" : "Create module"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingForce} onOpenChange={(o) => !o && setPendingForce(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm revoking live grants?</AlertDialogTitle>
            <AlertDialogDescription>{pendingForce?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmForce}
              disabled={saving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {saving ? "Saving..." : "Revoke and save"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SubjectCheckbox({
  subject,
  module,
  checked,
  onToggle,
}: {
  subject: AdminSubjectRow;
  module: AdminModuleRow | null;
  checked: boolean;
  onToggle: (key: string, checked: boolean) => void;
}) {
  const elsewhere = subject.moduleKey && subject.moduleKey !== module?.key;
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={`module-subject-${subject.key}`}
        checked={checked}
        onCheckedChange={(next) => onToggle(subject.key, next === true)}
      />
      <Label htmlFor={`module-subject-${subject.key}`} className="font-normal">
        {subject.label}
        {elsewhere && <span className="ml-1 text-xs text-muted-foreground">currently in {subject.moduleKey}</span>}
      </Label>
    </div>
  );
}

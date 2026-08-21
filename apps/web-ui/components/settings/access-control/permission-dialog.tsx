"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  useCreatePermission,
  useUpdatePermission,
  RegistryRequestError,
  type AdminActionRow,
} from "@/lib/queries/rbac-registry";

/**
 * `key` mirrors the server's ACTION_KEY_PATTERN (registry-admin-writes.ts).
 * Validated in both places on purpose: the client message is immediate
 * feedback, the server one is the actual boundary.
 */
const schema = z.object({
  key: z
    .string()
    .min(1, "A key is required.")
    .regex(/^[a-z][a-z0-9_]*$/, "Use a lowercase identifier, e.g. 'restart'."),
  label: z.string().trim().min(1, "A label is required."),
  description: z.string().optional(),
  aliasOfKey: z.string().optional(),
  isDangerous: z.boolean(),
  sortOrder: z.coerce.number().int().min(0).max(9999),
});

type FormValues = z.infer<typeof schema>;

const NO_ALIAS = "__none__";

export function PermissionDialog({
  open,
  onOpenChange,
  permission,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  permission: AdminActionRow | null;
  actions: AdminActionRow[];
}) {
  const create = useCreatePermission();
  const update = useUpdatePermission();
  const isEdit = Boolean(permission);
  // RULING (human partner, overrides the brief): a built-in row is not
  // editable at all, not even its label. The compiler resolves grants by row
  // ID — a tenant-side relabel of a global row would need a new row (a new
  // id), and every existing rule still points at the OLD id. mergeByKey()
  // then drops the shadowed global row from the snapshot the compiler reads,
  // so those rules resolve to nothing and the grant silently stops working
  // for every role in the tenant. The API backs this with a 403; this view
  // is the honest front door for that refusal, not a decoration on top of it.
  const readOnly = Boolean(permission?.isGlobal);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { key: "", label: "", description: "", aliasOfKey: NO_ALIAS, isDangerous: false, sortOrder: 100 },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      key: permission?.key ?? "",
      label: permission?.label ?? "",
      description: permission?.description ?? "",
      aliasOfKey: permission?.aliasOfKey ?? NO_ALIAS,
      isDangerous: permission?.isDangerous ?? false,
      sortOrder: permission?.sortOrder ?? 100,
    });
  }, [open, permission, form]);

  async function onSubmit(values: FormValues) {
    const payload = {
      ...values,
      description: values.description || null,
      aliasOfKey: values.aliasOfKey === NO_ALIAS ? null : values.aliasOfKey,
    };
    try {
      if (permission) {
        await update.mutateAsync({ id: permission.id, ...payload });
        toast.success(`Updated '${values.label}'.`);
      } else {
        await create.mutateAsync(payload);
        toast.success(`Created '${values.label}'. Tick it on a module to make it grantable.`);
      }
      onOpenChange(false);
    } catch (error) {
      // Branch on status, never on message text (it has already been
      // reworded once). A 403 here would mean the row went global under us
      // mid-edit; a 400 is a validation failure the server caught that the
      // client schema did not.
      const message =
        error instanceof RegistryRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to save the permission.";
      toast.error(message);
    }
  }

  const saving = create.isPending || update.isPending;

  if (readOnly && permission) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{permission.label}</DialogTitle>
            <DialogDescription>
              A permission is a verb a role can be granted. It only appears in the role grid once a module
              makes it grantable.
            </DialogDescription>
          </DialogHeader>

          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Built-in permission — read only</AlertTitle>
            <AlertDescription>
              The compiler resolves grants by row id. Relabelling this row would give it a new id that no
              existing grant points at, silently revoking it for every role in the tenant. Create your own
              permission instead if you need something different.
            </AlertDescription>
          </Alert>

          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Key</dt>
              <dd>
                <code className="rounded bg-muted px-1.5 py-0.5">{permission.key}</code>
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Description</dt>
              <dd>{permission.description ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Behaves as</dt>
              <dd>
                {permission.aliasOfKey ? (
                  <code className="rounded bg-muted px-1.5 py-0.5">{permission.aliasOfKey}</code>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Dangerous</dt>
              <dd>{permission.isDangerous ? <Badge variant="destructive">Dangerous</Badge> : "No"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Column order</dt>
              <dd>{permission.sortOrder}</dd>
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${permission?.label}` : "New permission"}</DialogTitle>
          <DialogDescription>
            A permission is a verb a role can be granted. It only appears in the role grid once a module
            makes it grantable.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="perm-key">Key</Label>
            <Input id="perm-key" {...form.register("key")} placeholder="restart" />
            {form.formState.errors.key && (
              <p className="text-xs text-destructive">{form.formState.errors.key.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="perm-label">Label</Label>
            <Input id="perm-label" {...form.register("label")} placeholder="Restart" />
            {form.formState.errors.label && (
              <p className="text-xs text-destructive">{form.formState.errors.label.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="perm-desc">Description</Label>
            <Input id="perm-desc" {...form.register("description")} placeholder="Shown in the role editor" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="perm-alias">Behaves as</Label>
            <Select
              value={form.watch("aliasOfKey")}
              onValueChange={(value) => form.setValue("aliasOfKey", value, { shouldDirty: true })}
            >
              <SelectTrigger id="perm-alias">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ALIAS}>Itself (needs code that checks it)</SelectItem>
                {actions
                  .filter((a) => !a.aliasOfKey && a.key !== permission?.key)
                  .map((a) => (
                    <SelectItem key={a.key} value={a.key}>
                      {a.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              A permission aliased to an existing one is enforced immediately, by whatever checks already
              exist for the verb it behaves as. A permission that behaves as itself enforces nothing until
              application code calls <code>authorize()</code> with its key — both are legitimate states, but
              only one does something today.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="perm-danger"
              checked={form.watch("isDangerous")}
              onCheckedChange={(checked) => form.setValue("isDangerous", checked === true, { shouldDirty: true })}
            />
            <Label htmlFor="perm-danger" className="font-normal">
              Dangerous — require a typed confirmation when granting it
            </Label>
          </div>

          <div className="space-y-2">
            <Label htmlFor="perm-order">Column order</Label>
            <Input id="perm-order" type="number" {...form.register("sortOrder")} className="w-28" />
            {form.formState.errors.sortOrder && (
              <p className="text-xs text-destructive">{form.formState.errors.sortOrder.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Spinner className="mr-2 h-4 w-4" />}
              {isEdit ? "Save" : "Create permission"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

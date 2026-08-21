"use client";

/**
 * Principal attributes for one member (Workstream E).
 *
 * Which attributes exist is itself dynamic — the list comes from
 * `rbac_principal_attributes`, so an administrator can introduce a new
 * attribute without a deploy and it appears here automatically.
 *
 * `user.allowedAccountIds` deliberately gets a multi-select bound to the
 * tenant's real accounts rather than a free-text field: a typo in an account id
 * silently widens or narrows access, and nothing downstream would flag it.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { useAccounts } from "@/lib/queries/accounts";
import {
    useMemberAttributes,
    useUpdateMemberAttributes,
    type PrincipalAttributeDef,
} from "@/lib/queries/permissions";

/** The one attribute that must never be typed by hand. */
const ACCOUNT_BOUND_KEY = "user.allowedAccountIds";

export function MemberAttributesDialog({
    memberId,
    open,
    onOpenChange,
}: {
    memberId: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { data, isLoading, error } = useMemberAttributes(open ? memberId : null);
    const update = useUpdateMemberAttributes(memberId);
    const { data: accountsData } = useAccounts();

    const [values, setValues] = useState<Record<string, unknown>>({});

    // Reset whenever a different member is opened, so edits never leak across rows.
    useEffect(() => {
        setValues(data?.values ?? {});
    }, [data?.values, memberId]);

    const accounts = useMemo(
        () => accountsData?.accounts ?? [],
        [accountsData],
    );

    const setValue = (key: string, value: unknown) =>
        setValues((prev) => ({ ...prev, [key]: value }));

    const handleSave = async () => {
        try {
            await update.mutateAsync({ values });
            toast.success("Attributes updated", {
                description: "Rules referencing them apply within about 5 seconds.",
            });
            onOpenChange(false);
        } catch (err) {
            toast.error("Could not update attributes", {
                description: err instanceof Error ? err.message : "Unknown error",
            });
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Attributes</DialogTitle>
                    <DialogDescription>
                        {data?.email
                            ? `Values that permission rules can reference for ${data.email}.`
                            : "Values that permission rules can reference for this member."}
                    </DialogDescription>
                </DialogHeader>

                {error ? (
                    <p className="text-sm text-destructive">
                        {error instanceof Error ? error.message : "Failed to load attributes."}
                    </p>
                ) : isLoading ? (
                    <p className="text-muted-foreground text-sm">Loading...</p>
                ) : !data || data.assignable.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                        No assignable attributes are defined yet. Add one under Settings →
                        Permissions before assigning it here.
                    </p>
                ) : (
                    <div className="space-y-5 py-1">
                        {data.assignable.map((attr) => (
                            <AttributeField
                                key={attr.key}
                                attr={attr}
                                value={values[attr.key]}
                                accounts={accounts}
                                onChange={(v) => setValue(attr.key, v)}
                            />
                        ))}
                    </div>
                )}

                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSave}
                        disabled={update.isPending || isLoading || !data}
                    >
                        {update.isPending ? "Saving..." : "Save"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function AttributeField({
    attr,
    value,
    accounts,
    onChange,
}: {
    attr: PrincipalAttributeDef;
    value: unknown;
    accounts: Array<{ accountId: string; name: string }>;
    onChange: (value: unknown) => void;
}) {
    if (attr.key === ACCOUNT_BOUND_KEY) {
        const selected = Array.isArray(value) ? (value as string[]) : [];
        const toggle = (accountId: string, checked: boolean) =>
            onChange(
                checked
                    ? [...selected, accountId]
                    : selected.filter((id) => id !== accountId),
            );

        return (
            <div className="space-y-2">
                <Label>{attr.label}</Label>
                {accounts.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                        No AWS accounts connected yet.
                    </p>
                ) : (
                    <ScrollArea className="h-40 rounded-md border p-2">
                        <div className="space-y-2">
                            {accounts.map((account) => (
                                <label
                                    key={account.accountId}
                                    className="flex items-center gap-2 text-sm"
                                >
                                    <Checkbox
                                        checked={selected.includes(account.accountId)}
                                        onCheckedChange={(checked) =>
                                            toggle(account.accountId, checked === true)
                                        }
                                    />
                                    <span className="font-medium">{account.name}</span>
                                    <span className="text-muted-foreground text-xs">
                                        {account.accountId}
                                    </span>
                                </label>
                            ))}
                        </div>
                    </ScrollArea>
                )}
                <p className="text-muted-foreground text-xs">
                    {selected.length === 0
                        ? "None selected — rules that reference this attribute will not grant anything."
                        : `${selected.length} of ${accounts.length} accounts selected.`}
                </p>
            </div>
        );
    }

    if (attr.valueType === "boolean") {
        return (
            <div className="flex items-center justify-between">
                <Label htmlFor={attr.key}>{attr.label}</Label>
                <Switch
                    id={attr.key}
                    checked={value === true}
                    onCheckedChange={(checked) => onChange(checked)}
                />
            </div>
        );
    }

    if (attr.valueType === "string[]") {
        const asText = Array.isArray(value) ? (value as string[]).join(", ") : "";
        return (
            <div className="space-y-2">
                <Label htmlFor={attr.key}>{attr.label}</Label>
                <Input
                    id={attr.key}
                    value={asText}
                    placeholder="comma separated"
                    onChange={(e) =>
                        onChange(
                            e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                        )
                    }
                />
            </div>
        );
    }

    return (
        <div className="space-y-2">
            <Label htmlFor={attr.key}>{attr.label}</Label>
            <Input
                id={attr.key}
                type={
                    attr.valueType === "number"
                        ? "number"
                        : attr.valueType === "date"
                          ? "date"
                          : "text"
                }
                value={value === undefined || value === null ? "" : String(value)}
                onChange={(e) =>
                    onChange(
                        attr.valueType === "number"
                            ? e.target.value === ""
                                ? null
                                : Number(e.target.value)
                            : e.target.value === ""
                              ? null
                              : e.target.value,
                    )
                }
            />
        </div>
    );
}

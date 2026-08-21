"use client";

import { useEffect, useMemo, useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogCancel,
    AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import type { PermissionSet } from "@/lib/rbac/types";
import type { SubjectOverrides } from "@/lib/rbac/role-subject-overrides";
import { useAbilityMeta, useGrantableCells } from "@/hooks/use-can";
import type { AbilityActionDef, AbilityModule } from "@/providers/ability-provider";

import { PermissionMatrix } from "./permission-matrix/matrix";
import {
    collapseFullyDeniedModules,
    hasAnyPermission,
    resetSubject,
    toggleModule,
    toggleSubject,
    toMatrixState,
    toPayload,
    type CarriedState,
    type MatrixState,
} from "./permission-matrix/use-matrix-state";

/**
 * Rows and columns come from the registry, not a copy of it.
 *
 * Rows: every module, sorted by sortOrder then key. Columns: verbs that at
 * least one module makes grantable, minus aliases. An alias resolves to its
 * target at compile time (rule-compiler.ts's resolveAlias), so a column for
 * `execute` would write a rule indistinguishable from the `update` column's —
 * two checkboxes for one grant. Cells: exist only where the registry says a
 * (module, verb) pair is grantable; a non-grantable cell renders disabled,
 * not absent, so a module like Dashboard stays read-only as DATA rather than
 * as code.
 */
function useGridShape() {
    const { modules, actions } = useAbilityMeta();
    const cells = useGrantableCells();

    const grantable = useMemo(() => new Set(cells.map((c) => `${c.moduleKey}::${c.actionKey}`)), [cells]);
    const grantedVerbs = useMemo(() => new Set(cells.map((c) => c.actionKey)), [cells]);

    const rows: AbilityModule[] = useMemo(
        () => [...modules].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key)),
        [modules]
    );
    const columns: AbilityActionDef[] = useMemo(
        () => actions.filter((a) => !a.aliasOfKey && grantedVerbs.has(a.key)),
        [actions, grantedVerbs]
    );

    function isGrantable(moduleKey: string, actionKey: string): boolean {
        return grantable.has(`${moduleKey}::${actionKey}`);
    }

    return { rows, columns, isGrantable };
}

/**
 * Subjects hidden from the grid by explicit product decision, keyed by subject key.
 *
 * Both entries below govern NOTHING: no `authorize()` call anywhere names them.
 * That is the bar for this list — a row an admin can tick that cannot change any
 * outcome is worse than no row, because it reads as a permission that is being
 * ignored. (Verify with `grep -rn "'<Key>'" apps/web-ui/app apps/web-ui/lib`
 * before adding one.)
 *
 * ── WHY A KEY LIST AND NOT A DISCRIMINATOR ──────────────────────────────────
 * The other two hide rules read the registry (key === moduleKey, kind ===
 * 'capability'), which is strictly better: a row added later is handled with no
 * code change. The tempting signal here is `navPath === null` — "owns no page" —
 * and it happens to select exactly these two today. Do NOT switch to it.
 * Owning no page does not mean governing nothing: `Discovery` had a NULL navPath
 * while gating six real endpoints, and auto-hiding it on that basis would have
 * silently produced the phantom-permission bug this list exists to prevent.
 * "Governs nothing" is a fact about call sites, which the registry cannot see,
 * so it has to be asserted by hand.
 *
 * ── Discovery ('Discovery Run', under Inventory) ─────────────────────────────
 * Retired in practice. Everything it used to gate — the scan-frequency form on
 * /app/inventory/settings, POST /api/inventory/sync, POST /api/discovery/execute,
 * GET /api/discovery/status, GET /api/inventory/status, GET /api/accounts/:id/scan
 * — now enforces the matching verb on `Resource`, the "Inventory Resource" row,
 * so the control an admin can see is the control that governs those operations.
 *
 * ── Billing (under Settings) ─────────────────────────────────────────────────
 * A placeholder for a feature that does not exist: no page under app/app, no API
 * route, no consumer. Seeded with every other subject in 20260730000000 and left
 * with a NULL navPath in 20260812100000. Nothing inherits anything by hiding it,
 * because no code ever asks the question.
 *
 * ── SHARED PROPERTY WORTH KNOWING ───────────────────────────────────────────
 * A role that ALREADY carries an override on a hidden subject keeps it, as a
 * `carried` entry with no row and no ↺ Reset to clear it from this screen. Same
 * behaviour the catch-alls and capability gates have had since 2112742 —
 * preserved rather than deleted, since the module row still governs it. Harmless
 * for both of these, as neither is consulted by anything.
 */
const HIDDEN_SUBJECT_KEYS = new Set(["Discovery", "Billing"]);

interface RoleDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    role?: { id: string; name: string; permissions: PermissionSet; overrides?: SubjectOverrides } | null;
    onSave: (name: string, permissions: PermissionSet, overrides: SubjectOverrides) => Promise<void>;
}

export function RoleDialog({ open, onOpenChange, role, onSave }: RoleDialogProps) {
    const { isLoaded, subjects } = useAbilityMeta();
    const { rows, columns, isGrantable } = useGridShape();
    const rowKeysSignature = rows.map((r) => r.key).join("|");
    const columnKeys = useMemo(() => new Set(columns.map((c) => c.key)), [columns]);
    const columnKeysSignature = columns.map((c) => c.key).join("|");

    /**
     * Three classes of subject are deliberately NOT rendered as submodule rows.
     * All stay fully enforced — they simply fall under their module's grant,
     * which is what the module checkbox already expresses.
     *
     *  1. A subject whose key equals its own module's key (the seeded
     *     'AIOps'/'IAM'/'Settings'/'Dashboard' catch-alls). Showing it just
     *     repeats the module's own label back at the operator once collapsed.
     *
     *  2. `kind: 'capability'` subjects — the five agent tool gates
     *     (AgentShell/AgentFile/AgentStorage/AgentWeb/AgentMcp). These gate
     *     no page and no admin screen: they gate which in-process LangChain
     *     tools the model may call mid-run (see lib/agent/tool-capabilities.ts).
     *     This screen is for the pages and records an admin administers, so
     *     backend tool plumbing does not belong in it. Keyed off the
     *     registry's own `kind` discriminator rather than a hardcoded name
     *     list, so a capability subject added later is hidden automatically.
     *
     *  3. HIDDEN_SUBJECT_KEYS — one-off product decisions, by key.
     *
     * Excluded from both the rendered rows AND the "known" subject set below,
     * so toMatrixState treats any existing override on one as `carried` —
     * preserved verbatim on save, exactly like a subject retired from the
     * registry — instead of being silently dropped. Same choice 2112742 made
     * for the catch-alls: not deleted, because the module row still fully
     * controls it.
     *
     * TRADE-OFF, ACCEPTED DELIBERATELY: an admin can no longer deny, say,
     * 'Agent: shell commands' on its own from this screen. Those capabilities
     * are now granted or denied wholesale with AIOps. They are still enforced
     * on every agent run; only the per-capability authoring control is gone.
     */
    const renderableSubjects = useMemo(
        () =>
            subjects.filter(
                (s) =>
                    s.moduleKey &&
                    s.key !== s.moduleKey &&
                    s.kind !== "capability" &&
                    !HIDDEN_SUBJECT_KEYS.has(s.key)
            ),
        [subjects]
    );

    /**
     * Subjects grouped by module, sorted for stable row order. Sourced from
     * the ability payload, not a copy of it — same discipline as
     * useGridShape above.
     */
    const subjectsByModule = useMemo(() => {
        const out: Record<string, typeof subjects> = {};
        for (const subject of renderableSubjects) {
            out[subject.moduleKey!] = [...(out[subject.moduleKey!] ?? []), subject];
        }
        for (const key of Object.keys(out)) {
            out[key].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
        }
        return out;
    }, [renderableSubjects]);
    const subjectKeys = useMemo(() => renderableSubjects.map((s) => s.key), [renderableSubjects]);
    const subjectKeysSignature = subjectKeys.join("|");

    /**
     * The same grouping as `subjectsByModule`, reduced to keys — what
     * collapseFullyDeniedModules counts. Derived from the rendered rows on
     * purpose: the rule may only be driven by rows the operator can actually see.
     */
    const subjectKeysByModule = useMemo(() => {
        const out: Record<string, string[]> = {};
        for (const [moduleKey, subjects] of Object.entries(subjectsByModule)) {
            out[moduleKey] = subjects.map((s) => s.key);
        }
        return out;
    }, [subjectsByModule]);

    const [name, setName] = useState("");
    const [matrix, setMatrix] = useState<MatrixState>({ modules: {}, overrides: {} });
    const [carried, setCarried] = useState<CarriedState>({ modules: {}, overrides: {} });
    const [saving, setSaving] = useState(false);
    const [nameError, setNameError] = useState<string | null>(null);
    const [permError, setPermError] = useState<string | null>(null);

    // Confirmed dangerous columns for this dialog session — once the operator
    // types the confirmation for a dangerous verb once, further ticks in that
    // same column don't re-prompt.
    const [confirmedDangerous, setConfirmedDangerous] = useState<Set<string>>(new Set());
    const [pendingToggle, setPendingToggle] = useState<{
        moduleKey: string;
        moduleLabel: string;
        subjectKey?: string;
        action: AbilityActionDef;
    } | null>(null);
    const [confirmText, setConfirmText] = useState("");

    // Reset form when dialog opens, role changes, or the registry finishes
    // loading (rowKeysSignature/columnKeysSignature/subjectKeysSignature flip
    // from empty to the real row/column/subject set — until then everything
    // would be misclassified as "carried").
    useEffect(() => {
        if (open) {
            const { state, carried: carriedIn } = toMatrixState(
                role?.permissions ?? null,
                role?.overrides ?? null,
                rows.map((r) => r.key),
                subjectKeys,
                columnKeys
            );
            setName(role?.name ?? "");
            // Normalize on open, not just on click: a role SAVED with a module
            // granted and every one of its subjects denied has to show the
            // module unchecked the moment it is opened, or the screen keeps
            // displaying a grant that authorizes nobody. Note this can flip Save
            // to disabled before the operator touches anything — if collapsing
            // leaves nothing granted, hasAnyPermission is correctly false,
            // because the role really was inert.
            setMatrix(collapseFullyDeniedModules(state, subjectKeysByModule));
            setCarried(carriedIn);
            setNameError(null);
            setPermError(null);
            setSaving(false);
            setConfirmedDangerous(new Set());
            setPendingToggle(null);
            setConfirmText("");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, role, rowKeysSignature, columnKeysSignature, subjectKeysSignature]);

    function applyPending(pending: NonNullable<typeof pendingToggle>) {
        setMatrix((prev) =>
            pending.subjectKey
                ? // Collapse only after a SUBJECT toggle. Deliberately not after
                  // toggleModule: ticking a module whose every subject denies
                  // that verb would collapse straight back on the same click,
                  // silently reverting an explicit action with no way to tell
                  // why. A module click stands; it normalizes on next open.
                  collapseFullyDeniedModules(
                      toggleSubject(
                          prev,
                          pending.moduleKey,
                          pending.subjectKey,
                          pending.action.key,
                          isGrantable,
                          // The siblings toggleSubject writes protective denies onto,
                          // so lifting the module doesn't widen past the clicked row.
                          // Same list the grid renders, so what gets protected is
                          // exactly what the operator can see.
                          subjectKeysByModule[pending.moduleKey] ?? []
                      ),
                      subjectKeysByModule
                  )
                : toggleModule(prev, pending.moduleKey, pending.action.key, isGrantable)
        );
        setPermError(null);
    }

    function requestModuleToggle(moduleKey: string, moduleLabel: string, action: AbilityActionDef) {
        const isChecked = (matrix.modules[moduleKey] ?? []).includes(action.key);
        if (!isChecked && action.isDangerous && !confirmedDangerous.has(action.key)) {
            setConfirmText("");
            setPendingToggle({ moduleKey, moduleLabel, action });
            return;
        }
        applyPending({ moduleKey, moduleLabel, action });
    }

    function requestSubjectToggle(
        moduleKey: string,
        subjectKey: string,
        subjectLabel: string,
        action: AbilityActionDef
    ) {
        // Only an explicit GRANT prompts. A deny removes power and never needs a
        // confirmation gate.
        const willGrant =
            matrix.overrides[subjectKey]?.[action.key] === undefined &&
            !(matrix.modules[moduleKey] ?? []).includes(action.key);
        if (willGrant && action.isDangerous && !confirmedDangerous.has(action.key)) {
            setConfirmText("");
            setPendingToggle({ moduleKey, moduleLabel: subjectLabel, subjectKey, action });
            return;
        }
        applyPending({ moduleKey, moduleLabel: subjectLabel, subjectKey, action });
    }

    function confirmDangerousToggle() {
        if (!pendingToggle) return;
        setConfirmedDangerous((prev) => new Set(prev).add(pendingToggle.action.key));
        applyPending(pendingToggle);
        setPendingToggle(null);
    }

    async function handleSave() {
        let valid = true;
        if (!name.trim()) {
            setNameError("Role name is required.");
            valid = false;
        } else {
            setNameError(null);
        }
        if (!hasAnyPermission(matrix, carried)) {
            setPermError("At least one permission must be selected.");
            valid = false;
        } else {
            setPermError(null);
        }
        if (!valid) return;

        setSaving(true);
        try {
            const payload = toPayload(matrix, carried);
            await onSave(name.trim(), payload.permissions, payload.overrides);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Failed to save role.";
            setNameError(message);
        } finally {
            setSaving(false);
        }
    }

    const isValid = name.trim().length > 0 && hasAnyPermission(matrix, carried);
    const title = role ? `Edit Role: ${role.name}` : "Create Custom Role";

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-6xl w-[92vw]">
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
                        {!isLoaded ? (
                            <div className="flex items-center justify-center rounded-md border py-10">
                                <Spinner label="Loading permissions..." />
                            </div>
                        ) : (
                            <PermissionMatrix
                                rows={rows}
                                columns={columns}
                                subjectsByModule={subjectsByModule}
                                state={matrix}
                                isGrantable={isGrantable}
                                onToggleModule={requestModuleToggle}
                                onToggleSubject={requestSubjectToggle}
                                onResetSubject={(subjectKey) =>
                                    setMatrix((prev) => resetSubject(prev, subjectKey))
                                }
                            />
                        )}
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

            <AlertDialog
                open={pendingToggle !== null}
                onOpenChange={(o) => {
                    if (!o) setPendingToggle(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Grant {pendingToggle?.action.label} on {pendingToggle?.moduleLabel}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {pendingToggle?.action.label} is a dangerous action. Type CONFIRM below to grant it.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <Input
                        autoComplete="off"
                        placeholder="CONFIRM"
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        aria-label="Type CONFIRM to grant this permission"
                    />
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={() => setPendingToggle(null)}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={confirmText !== "CONFIRM"}
                            onClick={confirmDangerousToggle}
                        >
                            Grant
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Dialog>
    );
}

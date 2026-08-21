"use client";

import { useEffect, useState } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { AlertTriangle } from "lucide-react";

/**
 * Typed-confirmation dialog for the two live capacity changes (enable / disable Spot).
 *
 * The user must type the service name. This mirrors the API's own gate — the route requires
 * `confirmServiceName` to match and rejects otherwise — so the UI is not the only thing
 * between a stray click and a rolling deployment. Both changes call ecs:UpdateService with
 * forceNewDeployment, which replaces every task in the service.
 *
 * NOTE ON VALIDATION: deliberately plain controlled state, NOT react-hook-form +
 * zodResolver, which the rest of the app uses for forms.
 *
 * An earlier version did use zodResolver, and it threw the Zod issues array as an UNCAUGHT
 * page error on every keystroke (visible as a climbing Next.js dev-overlay "Issues" count).
 * The cause is the @hookform/resolvers + Zod 4 mismatch this repo's CLAUDE.md warns about —
 * Zod 4 renamed `.errors` to `.issues`. The gate still functioned, but it polluted the error
 * overlay and would have buried real errors.
 *
 * Reaching for the form stack here bought nothing anyway: the only rule is a string equality,
 * and the AUTHORITATIVE validation is the route's own Zod schema, which re-checks the typed
 * name server-side. Two numeric inputs with min/max do not justify the dependency.
 */
/**
 * Default Spot share for a newly enabled service.
 *
 * Deliberately NOT 100. All-Spot means a capacity failure moves every task in the service at once;
 * a blend keeps part of it on guaranteed capacity while the rest follows Spot pricing. 100% stays
 * available — it is the right answer in sandbox — it just is not the default anyone gets by
 * accident on a production service.
 */
const DEFAULT_SPOT_PCT = "50";

export function ConfirmServiceDialog({
    open,
    onOpenChange,
    mode,
    serviceName,
    clusterName,
    accountId,
    region,
    pending,
    managed = false,
    initialSpotPct = null,
    error,
    onConfirm,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: "enable" | "disable";
    serviceName: string;
    clusterName?: string | null;
    accountId: string;
    region: string;
    pending: boolean;
    /** Nucleus already manages this service, so this is a change rather than an opt-in. */
    managed?: boolean;
    /** Seed the percentage from the service's CURRENT split instead of the new-service default. */
    initialSpotPct?: number | null;
    error?: string | null;
    onConfirm: (values: {
        confirmServiceName: string;
        spotWeight?: number;
        onDemandWeight?: number;
        onDemandBase?: number;
    }) => void;
}) {
    const [typedName, setTypedName] = useState("");
    /**
     * Spot share as a PERCENTAGE, 0-100. This is the input operators actually think in.
     *
     * It maps to ECS capacity-provider weights as spotWeight = P, onDemandWeight = 100 - P. ECS
     * weights are ratios, so making them sum to 100 is what lets them be read as percentages —
     * 37/63 genuinely means 37% Spot.
     */
    const seed = initialSpotPct != null && initialSpotPct > 0 ? String(initialSpotPct) : DEFAULT_SPOT_PCT;
    const [spotPct, setSpotPct] = useState(seed);
    const [onDemandBase, setOnDemandBase] = useState("0");

    // Reset on every open so a previous confirmation cannot be reused by reopening the
    // dialog against a different service.
    useEffect(() => {
        if (open) {
            setTypedName("");
            setSpotPct(seed);
            setOnDemandBase("0");
        }
    }, [open, serviceName, seed]);

    const isEnable = mode === "enable";

    // Exact match only — no trim, no case-insensitivity. A near-miss must not unlock this.
    const nameMatches = typedName === serviceName;
    const pct = Number(spotPct);
    const base = Number(onDemandBase);
    const pctValid = !isEnable || (Number.isInteger(pct) && pct >= 0 && pct <= 100);
    const baseValid = !isEnable || (Number.isInteger(base) && base >= 0 && base <= 100);

    // Percentage -> ECS weights. Summing to 100 is what makes the numbers readable as percentages.
    const spotWeight = pct;
    const onDemandWeight = 100 - pct;

    /**
     * 0% Spot is BLOCKED here, and that is deliberate rather than a validation oversight.
     *
     * Applying Spot 0 / On-Demand 100 produces exactly the signature of an automated fallback:
     * capacityState becomes 'on_demand' and the service matches the hourly restore job's candidate
     * query, which would then harden it back to full Spot within the hour. So "enable at 0%" would
     * silently become "enable at 100%" — the opposite of what was asked for.
     *
     * The route agrees independently: spotWeight has a minimum of 1.
     *
     * 0% is a real intent, it just is not an ENABLE. For a service Nucleus already manages it is the
     * Disable action, which sets the same strategy AND marks the service opted out so automation
     * leaves it alone. For a service that was never enabled, 0% means "do nothing".
     */
    const zeroSpot = isEnable && pctValid && pct === 0;
    const canSubmit = nameMatches && pctValid && baseValid && !zeroSpot && !pending;

    const submit = () => {
        if (!canSubmit) return;
        onConfirm({
            confirmServiceName: typedName,
            ...(isEnable ? { spotWeight, onDemandWeight, onDemandBase: base } : {}),
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {isEnable ? (managed ? "Change Spot capacity" : "Enable Fargate Spot") : "Disable Fargate Spot"}
                    </DialogTitle>
                    <DialogDescription>
                        {isEnable
                            ? managed
                                ? "This changes how much of the service runs on interruptible Spot capacity."
                                : "This moves production traffic onto interruptible Spot capacity."
                            : "This moves the service to 100% On-Demand and stops Spot automation."}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="rounded-md bg-muted p-3 text-sm">
                        <div className="font-medium">{serviceName}</div>
                        <div className="text-xs text-muted-foreground">
                            {clusterName ?? "—"} · <span className="font-mono">{accountId}</span> · {region}
                        </div>
                    </div>

                    <Alert>
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription className="text-xs">
                            {/* Say plainly what happens. A rolling deployment is the part people do
                                not expect from what looks like a settings change. */}
                            This triggers a rolling ECS deployment — every task in the service will be replaced.
                            {isEnable
                                ? " Spot capacity can be reclaimed by AWS at ~2 minutes' notice; Nucleus will fall the service back to On-Demand automatically if Spot runs out."
                                : " Nucleus will not restore this service to Spot afterwards."}
                        </AlertDescription>
                    </Alert>

                    {isEnable && (
                        <div className="space-y-3">
                            <div className="flex items-baseline justify-between gap-3">
                                <Label htmlFor="spotPct" className="text-xs">
                                    Spot capacity
                                </Label>
                                <span className="font-mono text-xs text-muted-foreground">
                                    {pctValid ? `${pct}% Spot · ${100 - pct}% On-Demand` : "0–100 only"}
                                </span>
                            </div>

                            <div className="flex items-center gap-3">
                                {/* Slider for the shape of the choice, number for an exact value —
                                    37% is as valid as 50% and should not need dragging to hit. */}
                                <input
                                    id="spotPct"
                                    type="range"
                                    min={0}
                                    max={100}
                                    step={1}
                                    value={pctValid ? pct : 0}
                                    onChange={(e) => setSpotPct(e.target.value)}
                                    className="h-2 flex-1 cursor-pointer accent-foreground"
                                    aria-label="Spot capacity percentage"
                                />
                                <div className="flex items-center gap-1">
                                    <Input
                                        type="number"
                                        min={0}
                                        max={100}
                                        value={spotPct}
                                        onChange={(e) => setSpotPct(e.target.value)}
                                        className="w-20"
                                        aria-label="Spot capacity percentage, exact value"
                                    />
                                    <span className="text-sm text-muted-foreground">%</span>
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs text-muted-foreground">Presets:</span>
                                {([30, 50, 70, 100] as const).map((v) => (
                                    <Button
                                        key={v}
                                        type="button"
                                        variant={pct === v ? "default" : "outline"}
                                        size="sm"
                                        className="h-7 text-xs"
                                        onClick={() => setSpotPct(String(v))}
                                    >
                                        {v}% Spot
                                    </Button>
                                ))}
                            </div>

                            {!pctValid && <p className="text-xs text-red-600">Enter a whole number from 0 to 100.</p>}

                            {/* 0% is a legitimate intent that this action cannot express — say which
                                action does, rather than failing with a bare validation error. */}
                            {pctValid && pct === 100 && (
                                <Alert>
                                    <AlertTriangle className="h-4 w-4" />
                                    <AlertDescription className="text-xs">
                                        100% Spot leaves no On-Demand headroom: when capacity runs out every task
                                        moves at once, so the whole service rides one rolling deployment. Fine for
                                        non-production. For production, a blend such as 30% or 50% keeps part of the
                                        service on guaranteed capacity throughout.
                                    </AlertDescription>
                                </Alert>
                            )}

                            {zeroSpot && (
                                <Alert variant="destructive">
                                    <AlertDescription className="text-xs">
                                        0% Spot means the service runs entirely On-Demand, which is not something
                                        “Enable Spot” can set: Nucleus would read it as a capacity failure and move
                                        the service back onto Spot within the hour. Use <strong>Disable</strong> on a
                                        service Nucleus already manages — that applies the same 100% On-Demand
                                        strategy and marks it opted out, so automation leaves it alone.
                                    </AlertDescription>
                                </Alert>
                            )}

                            <details className="text-xs">
                                <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
                                <div className="mt-2 space-y-1">
                                    <Label htmlFor="onDemandBase" className="text-xs">
                                        On-Demand base
                                    </Label>
                                    <Input
                                        id="onDemandBase"
                                        type="number"
                                        min={0}
                                        max={100}
                                        value={onDemandBase}
                                        onChange={(e) => setOnDemandBase(e.target.value)}
                                        className="w-28"
                                    />
                                    <p className="text-muted-foreground">
                                        {baseValid
                                            ? base > 0
                                                ? `The first ${base} task(s) always run On-Demand; the ${pctValid ? pct : 0}% split applies above that.`
                                                : "A guaranteed number of On-Demand tasks, held back from the split entirely. 0 means the split applies to every task."
                                            : "Must be a whole number from 0 to 100."}
                                    </p>
                                </div>
                            </details>
                        </div>
                    )}

                    <div className="space-y-1">
                        <Label htmlFor="confirmServiceName" className="text-xs">
                            Type <span className="font-mono font-semibold">{serviceName}</span> to confirm
                        </Label>
                        <Input
                            id="confirmServiceName"
                            autoComplete="off"
                            placeholder={serviceName}
                            value={typedName}
                            onChange={(e) => setTypedName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") submit();
                            }}
                        />
                        {typedName.length > 0 && !nameMatches && (
                            <p className="text-xs text-red-600">Type &quot;{serviceName}&quot; exactly to confirm.</p>
                        )}
                    </div>

                    {error && (
                        <Alert variant="destructive">
                            {/* Server errors carry actionable detail (e.g. the cluster's real capacity
                                providers on a 409), so show them verbatim. */}
                            <AlertDescription className="text-xs">{error}</AlertDescription>
                        </Alert>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        Cancel
                    </Button>
                    <Button variant={isEnable ? "default" : "destructive"} disabled={!canSubmit} onClick={submit}>
                        {pending && <Spinner className="mr-2 h-3 w-3" />}
                        {isEnable ? (managed ? "Apply capacity" : "Enable Spot") : "Disable Spot"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

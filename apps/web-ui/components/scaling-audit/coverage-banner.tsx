"use client";

import { AlertTriangle, Info } from "lucide-react";
import type { WatermarkGap } from "@/lib/db/repositories/scaling-audit/interface";
import { formatIstDate, SCOPE_LABELS } from "./shared";

/**
 * Two independent disclosures, deliberately separate:
 *
 *  - CoverageGapBanner (amber, conditional): "we could not confirm completeness
 *    for this window" — a transient, fixable condition.
 *  - CaptureScopeNote (neutral, ALWAYS shown): a permanent structural limit of
 *    the source APIs. It is not a gap and must never be styled as one, or it
 *    would cry wolf and be dismissed.
 *
 * The scope note is unconditional on purpose. A gap banner that disappears when
 * gaps == 0 would otherwise leave the page implying "no gaps, therefore complete
 * record" — but coverage rows attest that our POLLS succeeded, not that the
 * source APIs expose every path capacity can change by. A direct
 * ecs:UpdateService is invisible to Application Auto Scaling and so never
 * appears here at all. Kept in sync with the export's coverage statement
 * (app/api/scaling-audit/export/route.ts) so screen and file cannot disagree.
 */
export function CoverageBanner({ gaps }: { gaps: WatermarkGap[] }) {
    return (
        <div className="space-y-3">
            {gaps.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <div className="space-y-1 text-sm">
                            <p className="font-medium">
                                {gaps.length} known coverage gap{gaps.length === 1 ? "" : "s"} — this record may be incomplete for the affected window(s)
                            </p>
                            <ul className="list-inside list-disc space-y-0.5 text-xs">
                                {gaps.map((g, i) => (
                                    <li key={i}>
                                        {SCOPE_LABELS[g.scope] ?? g.scope} · account {g.accountId} · {g.region} —{" "}
                                        {g.gapReason ?? "unspecified reason"}
                                        {g.gapFromAt && g.gapToAt ? ` (${formatIstDate(g.gapFromAt)} → ${formatIstDate(g.gapToAt)} IST)` : null}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </div>
            )}

            <div className="rounded-md border bg-muted/40 p-3 text-muted-foreground">
                <div className="flex items-start gap-2">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-1 text-xs">
                        <p>
                            <span className="font-medium text-foreground">Capture scope.</span>{" "}
                            <span className="font-medium">ASG:</span> every capacity change is recorded whatever its origin, including console/CLI changes — the trigger is identified, the individual principal is not.{" "}
                            <span className="font-medium">ECS:</span> only changes initiated by Application Auto Scaling are recorded. A direct{" "}
                            <code className="rounded bg-muted px-1 py-0.5 font-mono">ecs:UpdateService</code> from the console, CLI, or a deployment pipeline does not appear in the source API and is <span className="font-medium text-foreground">absent from this record</span>.
                        </p>
                        <p>
                            Coverage gaps above report whether polls of the source APIs succeeded — not that those APIs expose every path capacity can change by. Naming individual principals, and capturing direct{" "}
                            <code className="rounded bg-muted px-1 py-0.5 font-mono">ecs:UpdateService</code> calls, both require CloudTrail integration (not yet implemented).
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}

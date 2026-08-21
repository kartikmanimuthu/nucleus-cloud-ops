"use client";

import { cn } from "@/lib/utils";

/**
 * The account / region identity block, with one deliberate priority order:
 *
 *   1. Account NAME    what a human recognises
 *   2. Account NUMBER  the unambiguous identifier
 *   3. Region          narrowest scope
 *
 * Shared by Spot Guard and Scale Sentinel, in both their list rows and their
 * detail views, so the order cannot drift between the four places it appears.
 * Change the tiers here, not at the call sites.
 *
 * Kept deliberately quiet: every tier stays at the table's existing text-xs, and
 * priority is carried only by font weight and muted-foreground steps. The cells
 * beside this one (resource name, cluster, status) are all text-xs too, so a
 * larger or bolder treatment here would pull the eye to the account instead of to
 * the resource the row is actually about.
 */

/** Account numbers are 12 digits; monospace stops them jittering between rows. */
const NUMBER_CLASS = "font-mono text-xs text-muted-foreground";
const NAME_CLASS = "text-xs font-medium text-foreground";
const REGION_CLASS = "text-xs text-muted-foreground/70";

export interface AccountRegionProps {
    accountId: string;
    /** Omit when unresolved — the number is then promoted so nothing looks blank. */
    accountName?: string | null;
    region?: string | null;
    className?: string;
    /** `inline` renders one line for dense headers; default stacks the three tiers. */
    layout?: "stacked" | "inline";
}

export function AccountRegion({ accountId, accountName, region, className, layout = "stacked" }: AccountRegionProps) {
    const name = accountName?.trim() || null;

    if (layout === "inline") {
        return (
            <span className={cn("inline-flex flex-wrap items-baseline gap-x-2", className)}>
                {name && <span className={NAME_CLASS}>{name}</span>}
                {/* With no name, the number carries top billing rather than leaving a gap. */}
                <span className={name ? NUMBER_CLASS : NAME_CLASS}>{accountId}</span>
                {region && <span className={REGION_CLASS}>{region}</span>}
            </span>
        );
    }

    return (
        <div className={cn("min-w-0", className)}>
            {name && <div className={cn(NAME_CLASS, "truncate")} title={name}>{name}</div>}
            <div className={name ? NUMBER_CLASS : NAME_CLASS}>{accountId}</div>
            {region && <div className={REGION_CLASS}>{region}</div>}
        </div>
    );
}

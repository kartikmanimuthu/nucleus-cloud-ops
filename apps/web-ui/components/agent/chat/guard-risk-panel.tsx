"use client";

import { cn } from "@/lib/utils";
import { ShieldAlert } from "lucide-react";
import type { RunGuardVerdict } from "./run-state";

const SEVERITY_STYLES: Record<RunGuardVerdict["severity"], string> = {
  HIGH: "bg-red-500/10 text-red-600 border-red-500/30",
  MEDIUM: "bg-amber-500/10 text-amber-600 border-amber-500/30",
  LOW: "bg-muted text-muted-foreground border-border",
};

export function GuardRiskPanel({ guard }: { guard: RunGuardVerdict }) {
  return (
    <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/5 p-2.5 text-xs space-y-1.5">
      <div className="flex items-center gap-2 font-semibold text-red-700 dark:text-red-400">
        <ShieldAlert className="h-3.5 w-3.5" />
        Guard: destructive action detected
        <span className={cn("ml-auto rounded border px-1.5 py-0.5 text-[10px] font-bold", SEVERITY_STYLES[guard.severity])}>
          {guard.severity}
        </span>
      </div>
      <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        <dt className="text-xs font-medium text-muted-foreground">Action</dt>
        <dd className="text-foreground">{guard.action}</dd>
        <dt className="text-xs font-medium text-muted-foreground">Blast radius</dt>
        <dd>{guard.blastRadius}</dd>
        <dt className="text-xs font-medium text-muted-foreground">Reversible</dt>
        <dd>{guard.reversible ? "Yes" : "No — treat as permanent"}</dd>
        {guard.saferPath && (
          <>
            <dt className="text-xs font-medium text-muted-foreground">Safer path</dt>
            <dd>{guard.saferPath}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

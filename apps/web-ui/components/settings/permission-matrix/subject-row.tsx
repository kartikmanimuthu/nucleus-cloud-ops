"use client";

import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { AbilityActionDef } from "@/providers/ability-provider";

import { cellState, effectiveChecked, type MatrixState } from "./use-matrix-state";

export interface SubjectRowProps {
  moduleKey: string;
  subjectKey: string;
  subjectLabel: string;
  columns: AbilityActionDef[];
  state: MatrixState;
  isGrantable: (moduleKey: string, actionKey: string) => boolean;
  onToggle: (actionKey: string) => void;
  onReset: () => void;
}

export function SubjectRow({
  moduleKey,
  subjectKey,
  subjectLabel,
  columns,
  state,
  isGrantable,
  onToggle,
  onReset,
}: SubjectRowProps) {
  const cells = state.overrides[subjectKey] ?? {};
  const hasOverride = Object.keys(cells).length > 0;

  return (
    <TableRow className="bg-muted/20">
      <TableCell className="py-2 pl-10 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          {subjectLabel}
          {hasOverride && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 gap-1 px-1.5 text-xs"
              onClick={onReset}
              aria-label={`Reset ${subjectLabel} to inherited`}
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          )}
        </span>
      </TableCell>
      {columns.map((col) => {
        const grantable = isGrantable(moduleKey, col.key);
        const cell = cellState(state, subjectKey, col.key);
        const checked = effectiveChecked(state, moduleKey, subjectKey, col.key);
        return (
          <TableCell key={col.key} className="py-2 text-center">
            <span className="relative inline-flex items-center justify-center">
              <Checkbox
                checked={checked}
                onCheckedChange={() => onToggle(col.key)}
                disabled={!grantable}
                // An inherited cell is muted and dashed so "this is the module's
                // value, not a decision made here" is visible at a glance.
                className={cn(
                  cell === "inherit" && "border-dashed opacity-60",
                  cell === "deny" && "border-destructive"
                )}
                aria-label={`${col.label} ${subjectLabel} (${cell})`}
              />
              {cell !== "inherit" && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute -right-2 -top-1 h-1.5 w-1.5 rounded-full",
                    cell === "grant" ? "bg-primary" : "bg-destructive"
                  )}
                />
              )}
            </span>
          </TableCell>
        );
      })}
    </TableRow>
  );
}

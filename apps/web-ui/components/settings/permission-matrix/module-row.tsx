"use client";

import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
import type { AbilityActionDef } from "@/providers/ability-provider";

import type { MatrixState } from "./use-matrix-state";

export interface ModuleRowProps {
  moduleKey: string;
  moduleLabel: string;
  columns: AbilityActionDef[];
  state: MatrixState;
  subjectKeys: string[];
  expanded: boolean;
  isGrantable: (moduleKey: string, actionKey: string) => boolean;
  onToggleExpanded: () => void;
  onToggle: (action: AbilityActionDef) => void;
}

export function ModuleRow({
  moduleKey,
  moduleLabel,
  columns,
  state,
  subjectKeys,
  expanded,
  isGrantable,
  onToggleExpanded,
  onToggle,
}: ModuleRowProps) {
  const granted = state.modules[moduleKey] ?? [];
  // A collapsed override must never be invisible, or an admin edits a role
  // without knowing an exception is buried inside it.
  const overriddenCount = subjectKeys.filter(
    (key) => Object.keys(state.overrides[key] ?? {}).length > 0
  ).length;

  return (
    <TableRow className="min-h-[44px]">
      <TableCell className="py-3 font-medium">
        <span className="flex items-center gap-1">
          {subjectKeys.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={onToggleExpanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${moduleLabel} submodules`}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          ) : (
            <span className="inline-block w-6" />
          )}
          {moduleLabel}
          {overriddenCount > 0 && (
            <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs">
              {overriddenCount} override{overriddenCount === 1 ? "" : "s"}
            </Badge>
          )}
        </span>
      </TableCell>
      {columns.map((col) => (
        <TableCell key={col.key} className="py-3 text-center">
          <Checkbox
            checked={granted.includes(col.key)}
            onCheckedChange={() => onToggle(col)}
            disabled={!isGrantable(moduleKey, col.key)}
            aria-label={`${col.label} ${moduleLabel}`}
          />
        </TableCell>
      ))}
    </TableRow>
  );
}

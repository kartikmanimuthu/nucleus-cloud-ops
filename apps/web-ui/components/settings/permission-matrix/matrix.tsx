"use client";

import { Fragment, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AbilityActionDef, AbilityModule, AbilitySubjectDef } from "@/providers/ability-provider";

import { ModuleRow } from "./module-row";
import { SubjectRow } from "./subject-row";
import type { MatrixState } from "./use-matrix-state";

export interface PermissionMatrixProps {
  rows: AbilityModule[];
  columns: AbilityActionDef[];
  subjectsByModule: Record<string, AbilitySubjectDef[]>;
  state: MatrixState;
  isGrantable: (moduleKey: string, actionKey: string) => boolean;
  onToggleModule: (moduleKey: string, moduleLabel: string, action: AbilityActionDef) => void;
  onToggleSubject: (moduleKey: string, subjectKey: string, subjectLabel: string, action: AbilityActionDef) => void;
  onResetSubject: (subjectKey: string) => void;
}

export function PermissionMatrix({
  rows,
  columns,
  subjectsByModule,
  state,
  isGrantable,
  onToggleModule,
  onToggleSubject,
  onResetSubject,
}: PermissionMatrixProps) {
  // Collapsed by default: 7 modules x ~31 subjects x 4-6 verbs fully expanded is
  // an unusable wall.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLowerCase();

  const visibleSubjects = useMemo(() => {
    const out: Record<string, AbilitySubjectDef[]> = {};
    for (const [moduleKey, subjects] of Object.entries(subjectsByModule)) {
      out[moduleKey] = needle
        ? subjects.filter(
            (s) => s.label.toLowerCase().includes(needle) || s.key.toLowerCase().includes(needle)
          )
        : subjects;
    }
    return out;
  }, [subjectsByModule, needle]);

  function toggleExpanded(moduleKey: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(moduleKey)) next.delete(moduleKey);
      else next.add(moduleKey);
      return next;
    });
  }

  return (
    <div className="space-y-2">
      <Input
        placeholder="Filter submodules…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label="Filter submodules"
      />
      <div className="max-h-[65vh] overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-[38%] min-w-[16rem]">Module</TableHead>
              {columns.map((col) => (
                <TableHead key={col.key} className="w-20 text-center">
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const subjects = visibleSubjects[row.key] ?? [];
              // A filter match forces its module open, or the matches are hidden
              // behind a collapsed chevron and the box looks broken.
              const isOpen = expanded.has(row.key) || (needle.length > 0 && subjects.length > 0);
              return (
                // Fragment, not <>: this is the array element, so the key
                // belongs here. On the shorthand React warns and reconciles
                // rows by index — expanding one module then collapsing another
                // reuses the wrong checkbox state.
                <Fragment key={row.key}>
                  <ModuleRow
                    moduleKey={row.key}
                    moduleLabel={row.label}
                    columns={columns}
                    state={state}
                    subjectKeys={(subjectsByModule[row.key] ?? []).map((s) => s.key)}
                    expanded={isOpen}
                    isGrantable={isGrantable}
                    onToggleExpanded={() => toggleExpanded(row.key)}
                    onToggle={(action) => onToggleModule(row.key, row.label, action)}
                  />
                  {isOpen &&
                    subjects.map((subject) => (
                      <SubjectRow
                        key={`${row.key}:${subject.key}`}
                        moduleKey={row.key}
                        subjectKey={subject.key}
                        subjectLabel={subject.label}
                        columns={columns}
                        state={state}
                        isGrantable={isGrantable}
                        onToggle={(actionKey) => {
                          const action = columns.find((c) => c.key === actionKey);
                          if (action) onToggleSubject(row.key, subject.key, subject.label, action);
                        }}
                        onReset={() => onResetSubject(subject.key)}
                      />
                    ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Submodule cells inherit their module unless overridden. A dashed box is inherited; a dot marks an
        explicit grant or deny.
      </p>
    </div>
  );
}

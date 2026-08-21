/**
 * Every state transition the permission matrix can make, with no JSX.
 *
 * Extracted from role-dialog.tsx so the rules that actually matter — what a
 * click means, what inherits, what is carried through untouched — are testable
 * without rendering a dialog. The component files below are then only markup.
 */

import type { PermissionSet } from "@/lib/rbac/types";
import type { SubjectOverrides } from "@/lib/rbac/role-subject-overrides";

export type CellState = "inherit" | "grant" | "deny";

export interface MatrixState {
  /** moduleKey -> granted verbs. Mirrors the legacy permissions blob. */
  modules: Record<string, string[]>;
  /** subjectKey -> verb -> explicit override. Absent verb means inherit. */
  overrides: Record<string, Record<string, CellState>>;
}

/**
 * Grants the grid cannot render, kept verbatim so opening and saving a role is
 * never a silent revocation. Three ways a grant becomes unrenderable: its module
 * left the registry, its verb lost its column, or its subject left the registry.
 */
export interface CarriedState {
  modules: PermissionSet;
  overrides: SubjectOverrides;
}

/** Whether a (module, verb) cell may be written at all. */
export type IsGrantable = (moduleKey: string, actionKey: string) => boolean;

const READ = "read";

export function toMatrixState(
  permissions: PermissionSet | null | undefined,
  overrides: SubjectOverrides | null | undefined,
  moduleKeys: string[],
  subjectKeys: string[],
  columnKeys: Set<string>
): { state: MatrixState; carried: CarriedState } {
  const knownModules = new Set(moduleKeys);
  const knownSubjects = new Set(subjectKeys);

  const state: MatrixState = { modules: {}, overrides: {} };
  const carried: CarriedState = { modules: {}, overrides: {} };

  for (const key of moduleKeys) state.modules[key] = [];

  for (const [moduleKey, verbs] of Object.entries(permissions ?? {})) {
    const list = verbs ?? [];
    if (!knownModules.has(moduleKey)) {
      carried.modules[moduleKey] = [...list];
      continue;
    }
    state.modules[moduleKey] = list.filter((v) => columnKeys.has(v));
    const hidden = list.filter((v) => !columnKeys.has(v));
    if (hidden.length > 0) carried.modules[moduleKey] = hidden;
  }

  for (const [subjectKey, override] of Object.entries(overrides ?? {})) {
    const grant = override?.grant ?? [];
    const deny = override?.deny ?? [];
    if (!knownSubjects.has(subjectKey)) {
      carried.overrides[subjectKey] = { grant: [...grant], deny: [...deny] };
      continue;
    }
    const cells: Record<string, CellState> = {};
    const hiddenGrant = grant.filter((v) => !columnKeys.has(v));
    const hiddenDeny = deny.filter((v) => !columnKeys.has(v));
    for (const verb of grant) if (columnKeys.has(verb)) cells[verb] = "grant";
    // Deny applied second so it wins a contradictory stored payload, matching
    // syncRoleSubjectOverrides' tie-break.
    for (const verb of deny) if (columnKeys.has(verb)) cells[verb] = "deny";
    if (Object.keys(cells).length > 0) state.overrides[subjectKey] = cells;
    if (hiddenGrant.length > 0 || hiddenDeny.length > 0) {
      carried.overrides[subjectKey] = { grant: hiddenGrant, deny: hiddenDeny };
    }
  }

  return { state, carried };
}

export function cellState(state: MatrixState, subjectKey: string, actionKey: string): CellState {
  return state.overrides[subjectKey]?.[actionKey] ?? "inherit";
}

/** What the checkbox shows: the override if there is one, else the module's value. */
export function effectiveChecked(
  state: MatrixState,
  moduleKey: string,
  subjectKey: string,
  actionKey: string
): boolean {
  const override = cellState(state, subjectKey, actionKey);
  if (override === "grant") return true;
  if (override === "deny") return false;
  return (state.modules[moduleKey] ?? []).includes(actionKey);
}

function withOverrides(
  state: MatrixState,
  subjectKey: string,
  cells: Record<string, CellState>
): MatrixState {
  const next = { ...state, overrides: { ...state.overrides } };
  if (Object.keys(cells).length === 0) delete next.overrides[subjectKey];
  else next.overrides[subjectKey] = cells;
  return next;
}

export function toggleModule(
  state: MatrixState,
  moduleKey: string,
  actionKey: string,
  isGrantable: IsGrantable
): MatrixState {
  if (!isGrantable(moduleKey, actionKey)) return state;

  const current = new Set(state.modules[moduleKey] ?? []);
  if (current.has(actionKey)) {
    current.delete(actionKey);
    // Unchecking Read clears the row — you cannot act on what you cannot see.
    if (actionKey === READ) current.clear();
  } else {
    current.add(actionKey);
    // Checking any non-read verb implies Read. Guarded by isGrantable because
    // nothing guarantees a module that grants SOME verb also grants read.
    if (actionKey !== READ && isGrantable(moduleKey, READ)) current.add(READ);
  }
  return { ...state, modules: { ...state.modules, [moduleKey]: [...current] } };
}

/**
 * One click flips the cell to the opposite of what it inherits; a second click
 * returns it to inherit. There is no three-way cycle to hunt through, and the
 * meaning of a click is always "make this disagree with its module" or "stop
 * disagreeing".
 */
export function toggleSubject(
  state: MatrixState,
  moduleKey: string,
  subjectKey: string,
  actionKey: string,
  isGrantable: IsGrantable,
  /**
   * Every subject rendered under `moduleKey`, including `subjectKey` itself.
   *
   * Required, not defaulted: this is the list the module-lift below writes
   * protective denies onto. Defaulting it to `[]` would make a forgetful caller
   * silently widen a grant across every sibling — the exact failure this
   * parameter exists to prevent — and it would do so invisibly, since the
   * module checkbox would look identical either way.
   */
  moduleSubjectKeys: string[]
): MatrixState {
  if (!isGrantable(moduleKey, actionKey)) return state;

  const cells = { ...(state.overrides[subjectKey] ?? {}) };

  // Already overridden -> back to inherit.
  if (cells[actionKey]) {
    delete cells[actionKey];
    return withOverrides(state, subjectKey, cells);
  }

  const inheritedOn = (state.modules[moduleKey] ?? []).includes(actionKey);

  if (inheritedOn) {
    cells[actionKey] = "deny";
    // Denying Read denies everything else on this subject. "Everything else"
    // means every verb that was EFFECTIVE before this click — the union of
    // module-granted verbs and verbs this subject's overrides already granted
    // — not just what the module grants. A verb granted purely by an override
    // (never present in state.modules[moduleKey]) is just as visible-and-actable
    // as a module-granted one, so it must cascade-deny too. effectiveChecked
    // reads the PRE-toggle state, which is exactly "was this effective".
    if (actionKey === READ) {
      const candidates = new Set([
        ...(state.modules[moduleKey] ?? []),
        ...Object.keys(state.overrides[subjectKey] ?? {}),
      ]);
      for (const verb of candidates) {
        if (
          verb !== READ &&
          isGrantable(moduleKey, verb) &&
          effectiveChecked(state, moduleKey, subjectKey, verb)
        ) {
          cells[verb] = "deny";
        }
      }
    }
  } else {
    cells[actionKey] = "grant";
    // Granting a non-read verb implies Read, unless read is already effective.
    // readEffective must be override-aware: an explicit read cell decides
    // outright, and module membership is only the fallback when there is no
    // cell. Checking module membership alone (the old bug) let an explicit
    // read DENY hide behind a module grant, leaving a granted verb sitting on
    // top of a denied read.
    if (actionKey !== READ && isGrantable(moduleKey, READ)) {
      const readEffective = cells[READ]
        ? cells[READ] === "grant"
        : (state.modules[moduleKey] ?? []).includes(READ);
      // Deliberate: if read carries an explicit DENY, granting this verb
      // OVERWRITES that deny with a grant so the invariant holds (you cannot
      // act on what you cannot see, and its inverse: granting a verb makes
      // read effective). This reverses the user's earlier click on read — but
      // the alternative, a verb granted while read stays denied, breaks the
      // invariant outright. The user can re-deny read afterwards, which will
      // then correctly cascade-deny this verb again. Do not "fix" this back to
      // preserving the deny.
      if (!readEffective) cells[READ] = "grant";
    }
  }

  const withCells = withOverrides(state, subjectKey, cells);

  // ── Grant on a subject lifts the module, WITHOUT widening to siblings ────
  //
  // Product decision: a subject cannot hold a verb its module lacks, so
  // granting `read` on Members ticks `read` on IAM.
  //
  // But a module grant is a REAL grant that rule-compiler.ts expands to EVERY
  // subject of the module (one rule per subject — it never emits a rule named
  // after the module). Left alone, lifting IAM:read would silently make Roles
  // readable too. The requirement is the opposite: tick the module, leave the
  // siblings exactly as they were.
  //
  // So each sibling that would newly gain a lifted verb gets an explicit DENY,
  // which the compiler emits as an inverted rule and orders last, beating the
  // module grant it shadows. Net effect: the module row reads as granted, the
  // clicked subject is granted through it, and no sibling changes state.
  //
  // A sibling already carrying an explicit `grant` is left alone (the operator
  // asked for it); one already carrying a `deny` is left alone (already
  // protected, and rewriting would churn the value for no change).
  const liftedVerbs = Object.entries(cells)
    .filter(([verb, cell]) => cell === "grant" && isGrantable(moduleKey, verb))
    .map(([verb]) => verb)
    .filter((verb) => !(state.modules[moduleKey] ?? []).includes(verb));

  if (liftedVerbs.length === 0) return withCells;

  const moduleVerbs = [...new Set([...(state.modules[moduleKey] ?? []), ...liftedVerbs])];

  // The lifted verbs' own cells are now redundant — the module grants them
  // outright, so the cell would render as an "override" that changes nothing
  // and shows a misleading override badge. Drop them and let the row inherit.
  const remaining = { ...cells };
  for (const verb of liftedVerbs) delete remaining[verb];

  const nextOverrides = { ...withCells.overrides };
  if (Object.keys(remaining).length === 0) delete nextOverrides[subjectKey];
  else nextOverrides[subjectKey] = remaining;

  for (const sibling of moduleSubjectKeys) {
    if (sibling === subjectKey) continue;
    const siblingCells = { ...(nextOverrides[sibling] ?? {}) };
    let changed = false;
    for (const verb of liftedVerbs) {
      if (siblingCells[verb]) continue; // explicit grant or deny — respect it
      siblingCells[verb] = "deny";
      changed = true;
    }
    if (changed) nextOverrides[sibling] = siblingCells;
  }

  return {
    modules: { ...state.modules, [moduleKey]: moduleVerbs },
    overrides: nextOverrides,
  };
}

export function resetSubject(state: MatrixState, subjectKey: string): MatrixState {
  return withOverrides(state, subjectKey, {});
}

/**
 * The inverse of the module lift: a module whose every rendered subject denies a
 * verb loses that verb.
 *
 * Without this, unticking every submodule leaves the module row checked while
 * nothing under it is actually permitted — the module reads as fully granted and
 * authorizes nobody. Denying the last subject is the operator saying "no one
 * here gets this", and the module checkbox has to say the same thing.
 *
 * The denies are then dropped: with the module no longer granting the verb, they
 * suppress nothing, and leaving them would show an override badge on rows that
 * no longer disagree with anything. Same reasoning as the lift dropping its own
 * redundant cells.
 *
 * Applied per verb, independently. No special read handling is needed: if every
 * subject denies read, toggleSubject's cascade has already denied their other
 * effective verbs, so those verbs collapse by this same rule.
 *
 * @param subjectKeysByModule Only the subjects the grid RENDERS, keyed by
 * module. Hidden subjects (a module's own catch-all, and `kind: 'capability'`
 * rows — see role-dialog.tsx) are deliberately not counted: they are governed by
 * the module checkbox, so collapsing it denies them too. That is their
 * documented contract, and the accepted consequence is real — collapsing AIOps
 * this way also revokes the AIOps catch-all that gates /api/mcp-servers and
 * /api/settings/providers.
 */
export function collapseFullyDeniedModules(
  state: MatrixState,
  subjectKeysByModule: Record<string, string[]>
): MatrixState {
  const modules = { ...state.modules };
  const overrides = { ...state.overrides };
  let changed = false;

  for (const [moduleKey, verbs] of Object.entries(state.modules)) {
    const subjectKeys = subjectKeysByModule[moduleKey] ?? [];
    // A module with no rendered rows can never be collapsed. "Every subject
    // denies it" is vacuously true over an empty list, which would untick
    // Dashboard — whose only subject is its hidden catch-all — and leave it
    // impossible to tick again.
    if (subjectKeys.length === 0) continue;

    const collapsing = (verbs ?? []).filter((verb) =>
      subjectKeys.every((subjectKey) => cellState(state, subjectKey, verb) === "deny")
    );
    if (collapsing.length === 0) continue;

    changed = true;
    const dropped = new Set(collapsing);
    modules[moduleKey] = (verbs ?? []).filter((verb) => !dropped.has(verb));

    for (const subjectKey of subjectKeys) {
      const cells = { ...(overrides[subjectKey] ?? {}) };
      for (const verb of collapsing) delete cells[verb];
      // A subject may hold overrides on verbs that did not collapse; only the
      // now-redundant cells go.
      if (Object.keys(cells).length === 0) delete overrides[subjectKey];
      else overrides[subjectKey] = cells;
    }
  }

  return changed ? { modules, overrides } : state;
}

export function toPayload(
  state: MatrixState,
  carried: CarriedState
): { permissions: PermissionSet; overrides: SubjectOverrides } {
  const permissions: PermissionSet = {};
  for (const [moduleKey, verbs] of Object.entries(carried.modules)) {
    if (!(moduleKey in state.modules)) permissions[moduleKey] = [...verbs];
  }
  for (const [moduleKey, verbs] of Object.entries(state.modules)) {
    const hidden = carried.modules[moduleKey] ?? [];
    permissions[moduleKey] = [...new Set([...hidden, ...verbs])];
  }

  const overrides: SubjectOverrides = {};
  for (const [subjectKey, entry] of Object.entries(carried.overrides)) {
    overrides[subjectKey] = { grant: [...entry.grant], deny: [...entry.deny] };
  }
  for (const [subjectKey, cells] of Object.entries(state.overrides)) {
    const hidden = carried.overrides[subjectKey] ?? { grant: [], deny: [] };
    const grant = [...hidden.grant];
    const deny = [...hidden.deny];
    for (const [verb, cell] of Object.entries(cells)) {
      if (cell === "grant") grant.push(verb);
      else deny.push(verb);
    }
    overrides[subjectKey] = { grant: [...new Set(grant)], deny: [...new Set(deny)] };
  }

  return { permissions, overrides };
}

/**
 * A role must grant SOMETHING. Denials do not count: a role built only of
 * `cannot` rules authorizes nobody to do anything, and saving it would create a
 * role that looks configured and is inert.
 */
export function hasAnyPermission(state: MatrixState, carried: CarriedState): boolean {
  if (Object.values(state.modules).some((verbs) => verbs.length > 0)) return true;
  if (Object.values(carried.modules).some((verbs) => verbs.length > 0)) return true;
  if (Object.values(state.overrides).some((cells) => Object.values(cells).includes("grant"))) return true;
  return Object.values(carried.overrides).some((entry) => entry.grant.length > 0);
}

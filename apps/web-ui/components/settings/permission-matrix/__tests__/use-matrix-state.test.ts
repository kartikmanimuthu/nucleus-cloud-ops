import { describe, expect, it } from 'vitest';

import {
  cellState,
  collapseFullyDeniedModules,
  effectiveChecked,
  hasAnyPermission,
  resetSubject,
  toggleModule,
  toggleSubject,
  toMatrixState,
  toPayload,
  type MatrixState,
} from '../use-matrix-state';

const MODULE_KEYS = ['AIOps', 'Inventory'];
const SUBJECT_KEYS = ['Agent', 'Provider', 'Resource'];
const COLUMN_KEYS = new Set(['create', 'read', 'update', 'delete']);
const grantableAlways = () => true;
/** Subjects rendered under AIOps in these fixtures. */
const AIOPS_SUBJECTS = ['Agent', 'Provider'];
/** Subjects rendered under IAM in the cascade fixtures. */
const IAM_SUBJECTS = ['User', 'Role'];
/** The screenshot's real shape: Accounts renders exactly two subject rows. */
const ACCOUNTS_SUBJECTS = ['Account', 'AuditLog'];

function state(partial: Partial<MatrixState> = {}): MatrixState {
  return { modules: {}, overrides: {}, ...partial };
}

describe('toMatrixState', () => {
  it('loads module grants and overrides into editable state', () => {
    const { state: s } = toMatrixState(
      { AIOps: ['read', 'update'] },
      { Provider: { grant: [], deny: ['update'] } },
      MODULE_KEYS,
      SUBJECT_KEYS,
      COLUMN_KEYS
    );

    expect(s.modules.AIOps).toEqual(['read', 'update']);
    expect(s.overrides.Provider).toEqual({ update: 'deny' });
  });

  // Same property role-dialog.tsx's `carried` protects: opening and saving a
  // role must never silently revoke a grant the grid could not render.
  it('carries grants for modules and subjects the grid cannot show', () => {
    const { state: s, carried } = toMatrixState(
      { AIOps: ['read'], GhostModule: ['delete'] },
      { GhostSubject: { grant: ['read'], deny: [] } },
      MODULE_KEYS,
      SUBJECT_KEYS,
      COLUMN_KEYS
    );

    expect(s.modules.GhostModule).toBeUndefined();
    expect(carried.modules).toEqual({ GhostModule: ['delete'] });
    expect(carried.overrides).toEqual({ GhostSubject: { grant: ['read'], deny: [] } });
  });

  it('carries a verb with no column inside a module that has a row', () => {
    const { state: s, carried } = toMatrixState(
      { AIOps: ['read', 'exotic'] },
      {},
      MODULE_KEYS,
      SUBJECT_KEYS,
      COLUMN_KEYS
    );

    expect(s.modules.AIOps).toEqual(['read']);
    expect(carried.modules).toEqual({ AIOps: ['exotic'] });
  });

  // Minor coverage gap: a verb with no column inside a SUBJECT override that has
  // a row must round-trip untouched, the same guarantee toMatrixState already
  // gives module rows above.
  it('carries a verb with no column inside a subject override that has a row', () => {
    const { state: s, carried } = toMatrixState(
      {},
      { Provider: { grant: ['read', 'exotic'], deny: [] } },
      MODULE_KEYS,
      SUBJECT_KEYS,
      COLUMN_KEYS
    );

    expect(s.overrides.Provider).toEqual({ read: 'grant' });
    expect(carried.overrides).toEqual({ Provider: { grant: ['exotic'], deny: [] } });

    const payload = toPayload(s, carried);
    expect(payload.overrides.Provider.grant.sort()).toEqual(['exotic', 'read']);
  });
});

describe('effectiveChecked', () => {
  it('inherits the module value when there is no override', () => {
    const s = state({ modules: { AIOps: ['read'] } });
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'read')).toBe(true);
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'update')).toBe(false);
  });

  it('lets a deny override a granted module', () => {
    const s = state({ modules: { AIOps: ['read'] }, overrides: { Provider: { read: 'deny' } } });
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'read')).toBe(false);
  });

  it('lets a grant override an ungranted module', () => {
    const s = state({ modules: {}, overrides: { Provider: { read: 'grant' } } });
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'read')).toBe(true);
  });
});

describe('toggleSubject', () => {
  it('flips an inherited grant to an explicit deny', () => {
    const s = toggleSubject(state({ modules: { AIOps: ['read'] } }), 'AIOps', 'Provider', 'read', grantableAlways,
      AIOPS_SUBJECTS
    );
    expect(cellState(s, 'Provider', 'read')).toBe('deny');
  });

  // A grant on a subject LIFTS the module to match (product decision), so the
  // cell itself becomes redundant and is dropped — the row now inherits a
  // module that genuinely grants the verb. `effectiveChecked` is the assertion
  // that matters here: the subject ends up granted either way.
  it('flips an inherited denial to a grant by lifting the module', () => {
    const s = toggleSubject(state({ modules: {} }), 'AIOps', 'Provider', 'read', grantableAlways, AIOPS_SUBJECTS);
    expect(s.modules.AIOps).toEqual(['read']);
    expect(cellState(s, 'Provider', 'read')).toBe('inherit');
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'read')).toBe(true);
    // The lift must not reach the sibling.
    expect(effectiveChecked(s, 'AIOps', 'Agent', 'read')).toBe(false);
  });

  it('returns to inherit on a second click', () => {
    let s = toggleSubject(state({ modules: { AIOps: ['read'] } }), 'AIOps', 'Provider', 'read', grantableAlways,
      AIOPS_SUBJECTS
    );
    s = toggleSubject(s, 'AIOps', 'Provider', 'read', grantableAlways, AIOPS_SUBJECTS);
    expect(cellState(s, 'Provider', 'read')).toBe('inherit');
  });

  // You cannot act on what you cannot see — the subject-level twin of the
  // "unchecking Read clears the row" rule the module grid already has.
  it('denying read denies every other verb on that subject', () => {
    const s = toggleSubject(
      state({ modules: { AIOps: ['read', 'update', 'delete'] } }),
      'AIOps',
      'Provider',
      'read',
      grantableAlways,
      AIOPS_SUBJECTS
    );
    expect(s.overrides.Provider).toEqual({ read: 'deny', update: 'deny', delete: 'deny' });
  });

  it('granting a non-read verb also grants read, both lifted to the module', () => {
    const s = toggleSubject(state({ modules: {} }), 'AIOps', 'Provider', 'update', grantableAlways, AIOPS_SUBJECTS);
    // Both the clicked verb and its implied read lift, so both cells are
    // redundant and dropped.
    expect(new Set(s.modules.AIOps)).toEqual(new Set(['update', 'read']));
    expect(s.overrides.Provider).toBeUndefined();
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'update')).toBe(true);
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'read')).toBe(true);
    // BOTH lifted verbs must be protected on the sibling, not just the clicked one.
    expect(effectiveChecked(s, 'AIOps', 'Agent', 'update')).toBe(false);
    expect(effectiveChecked(s, 'AIOps', 'Agent', 'read')).toBe(false);
  });

  it('does not re-grant read when the module already grants it', () => {
    const s = toggleSubject(state({ modules: { AIOps: ['read'] } }), 'AIOps', 'Provider', 'update', grantableAlways, AIOPS_SUBJECTS);
    // read was already a module grant, so only `update` lifts.
    expect(new Set(s.modules.AIOps)).toEqual(new Set(['read', 'update']));
    expect(s.overrides.Provider).toBeUndefined();
    // read was already module-wide, so the sibling keeps it; only the newly
    // lifted `update` is protected.
    expect(effectiveChecked(s, 'AIOps', 'Agent', 'read')).toBe(true);
    expect(effectiveChecked(s, 'AIOps', 'Agent', 'update')).toBe(false);
  });

  it('never writes a cell the registry says is not grantable', () => {
    const s = toggleSubject(state({ modules: {} }), 'AIOps', 'Provider', 'delete', () => false, AIOPS_SUBJECTS);
    expect(s.overrides.Provider).toBeUndefined();
  });

  // Critical bug: the deny-read cascade iterated only state.modules[moduleKey],
  // so a verb granted purely by an override on this subject (never granted by
  // the module) survived a read-deny. `create` here is only effective because
  // of the override, and must be denied along with read.
  it('denying read cascades to a verb granted only by a subject override', () => {
    const s = toggleSubject(
      state({ modules: { AIOps: ['read'] }, overrides: { Provider: { create: 'grant' } } }),
      'AIOps',
      'Provider',
      'read',
      grantableAlways,
      AIOPS_SUBJECTS
    );
    expect(s.overrides.Provider).toEqual({ read: 'deny', create: 'deny' });
  });

  // Critical bug: readEffective checked only module membership, so an explicit
  // read deny was masked by the module's grant, letting a freshly-granted verb
  // (update) coexist with a denied read.
  //
  // Deliberate: granting a non-read verb here OVERWRITES the pre-existing
  // explicit read deny with a grant. This reverses the user's earlier click on
  // read, but the alternative — update granted, read denied — breaks the
  // "cannot act on what you cannot see" invariant outright. The user can
  // re-deny read afterwards, which will then correctly cascade-deny update
  // again. Do not "fix" this back to preserving the deny.
  it('granting a non-read verb overwrites an explicit read deny to keep read effective', () => {
    const s = toggleSubject(
      state({ modules: { AIOps: ['read'] }, overrides: { Provider: { read: 'deny' } } }),
      'AIOps',
      'Provider',
      'update',
      grantableAlways,
      AIOPS_SUBJECTS
    );
    // read was already a module grant so it does not lift; `update` does, and
    // its cell drops. The read deny is overwritten to a grant, which then also
    // becomes redundant against the module's existing read — leaving no cells.
    expect(new Set(s.modules.AIOps)).toEqual(new Set(['read', 'update']));
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'read')).toBe(true);
    expect(effectiveChecked(s, 'AIOps', 'Provider', 'update')).toBe(true);
  });

  // THE core requirement: ticking one subject lifts the module so the module row
  // reads as granted, but a sibling nobody touched must NOT become effective.
  // Since rule-compiler.ts expands a module grant to every subject, the only way
  // to hold both is a protective deny on the sibling. If this test ever fails
  // with Role effective, the module lift started widening again.
  it('lifting the module protects untouched siblings with a deny', () => {
    const s = toggleSubject(state({ modules: {} }), 'IAM', 'User', 'read', grantableAlways, IAM_SUBJECTS);

    expect(s.modules.IAM).toEqual(['read']);
    // The clicked subject inherits the module it just lifted.
    expect(cellState(s, 'User', 'read')).toBe('inherit');
    expect(effectiveChecked(s, 'IAM', 'User', 'read')).toBe(true);
    // The sibling is explicitly protected, so the lift did not reach it.
    expect(cellState(s, 'Role', 'read')).toBe('deny');
    expect(effectiveChecked(s, 'IAM', 'Role', 'read')).toBe(false);
  });

  it('respects a sibling that already carries an explicit grant', () => {
    const s = toggleSubject(
      state({ modules: {}, overrides: { Role: { read: 'grant' } } }),
      'IAM',
      'User',
      'read',
      grantableAlways,
      IAM_SUBJECTS
    );
    // Deliberately granted earlier — not overwritten with a protective deny.
    expect(effectiveChecked(s, 'IAM', 'Role', 'read')).toBe(true);
  });

  // A deny writes a subject cell and leaves the module alone, so unticking one
  // subject can never strip a verb from its siblings.
  it('a deny does not touch the module grant', () => {
    const s = toggleSubject(
      state({ modules: { IAM: ['read'] } }),
      'IAM',
      'User',
      'read',
      grantableAlways,
      IAM_SUBJECTS
    );
    expect(s.modules.IAM).toEqual(['read']);
    expect(cellState(s, 'User', 'read')).toBe('deny');
    expect(effectiveChecked(s, 'IAM', 'Role', 'read')).toBe(true);
  });
});

describe('toggleModule', () => {
  it('checking a non-read verb auto-checks read', () => {
    const s = toggleModule(state(), 'AIOps', 'update', grantableAlways);
    expect(new Set(s.modules.AIOps)).toEqual(new Set(['update', 'read']));
  });

  it('unchecking read clears the module row', () => {
    let s = toggleModule(state(), 'AIOps', 'update', grantableAlways);
    s = toggleModule(s, 'AIOps', 'read', grantableAlways);
    expect(s.modules.AIOps).toEqual([]);
  });
});

describe('collapseFullyDeniedModules', () => {
  const ALL_VERBS = ['create', 'read', 'update', 'delete'];
  const denyAll = () => ({ create: 'deny', read: 'deny', update: 'deny', delete: 'deny' }) as const;

  // THE reported bug: Accounts granted all four verbs while both of its rendered
  // subjects deny all four. Nobody can do anything, yet the module row reads as
  // fully granted. The module must fall back to unchecked, and the denies — now
  // redundant against a module that grants nothing — must drop so the rows
  // render as plain inherit instead of showing a misleading override badge.
  it('unchecks a module whose every subject denies every verb', () => {
    const s = collapseFullyDeniedModules(
      state({
        modules: { Accounts: [...ALL_VERBS] },
        overrides: { Account: { ...denyAll() }, AuditLog: { ...denyAll() } },
      }),
      { Accounts: ACCOUNTS_SUBJECTS }
    );

    expect(s.modules.Accounts).toEqual([]);
    expect(s.overrides.Account).toBeUndefined();
    expect(s.overrides.AuditLog).toBeUndefined();
  });

  it('leaves a module alone while any subject still inherits the verb', () => {
    const s = collapseFullyDeniedModules(
      state({
        modules: { Accounts: ['read'] },
        overrides: { Account: { read: 'deny' } },
      }),
      { Accounts: ACCOUNTS_SUBJECTS }
    );

    // AuditLog never disagreed, so it is still effectively granted through the
    // module — unchecking the module here would revoke a live grant.
    expect(s.modules.Accounts).toEqual(['read']);
    expect(cellState(s, 'Account', 'read')).toBe('deny');
    expect(effectiveChecked(s, 'Accounts', 'AuditLog', 'read')).toBe(true);
  });

  // Per-verb and independent. No special read-cascade rule is needed here: if
  // every subject denies read, the subject-level cascade has already denied
  // their other effective verbs, so those verbs collapse by this same rule.
  it('collapses only the verbs that are denied across the board', () => {
    const s = collapseFullyDeniedModules(
      state({
        modules: { Accounts: ['read', 'update'] },
        overrides: { Account: { update: 'deny' }, AuditLog: { update: 'deny' } },
      }),
      { Accounts: ACCOUNTS_SUBJECTS }
    );

    expect(s.modules.Accounts).toEqual(['read']);
    expect(s.overrides.Account).toBeUndefined();
    expect(s.overrides.AuditLog).toBeUndefined();
    expect(effectiveChecked(s, 'Accounts', 'Account', 'read')).toBe(true);
  });

  // The one genuine trap. Dashboard renders no subject rows at all (its only
  // subject is the hidden catch-all keyed like its module), so "every subject
  // denies it" is vacuously TRUE over an empty list. Without this guard
  // Dashboard's Read would untick itself and could never be ticked again.
  it('never collapses a module that renders no subject rows', () => {
    const s = collapseFullyDeniedModules(
      state({ modules: { Dashboard: ['read'] } }),
      { Dashboard: [] }
    );
    expect(s.modules.Dashboard).toEqual(['read']);
  });

  it('never collapses a module missing from the subject map entirely', () => {
    const s = collapseFullyDeniedModules(state({ modules: { Dashboard: ['read'] } }), {});
    expect(s.modules.Dashboard).toEqual(['read']);
  });

  // Decided deliberately: the rule fires off the RENDERED rows only. AIOps also
  // owns hidden subjects (the AIOps catch-all that gates /api/mcp-servers and
  // /api/settings/providers, plus the five agent capability gates), which are
  // governed by the module checkbox — so collapsing it denies them too. That is
  // the documented contract for hidden subjects, not a leak.
  it('collapses a module with hidden subjects off its visible rows alone', () => {
    const s = collapseFullyDeniedModules(
      state({
        modules: { AIOps: ['read'] },
        overrides: { Agent: { read: 'deny' }, Provider: { read: 'deny' } },
      }),
      { AIOps: AIOPS_SUBJECTS }
    );
    expect(s.modules.AIOps).toEqual([]);
  });

  it('drops only the collapsed verb from a subject holding other overrides', () => {
    const s = collapseFullyDeniedModules(
      state({
        modules: { Accounts: ['update'] },
        overrides: {
          Account: { update: 'deny', read: 'grant' },
          AuditLog: { update: 'deny' },
        },
      }),
      { Accounts: ACCOUNTS_SUBJECTS }
    );

    expect(s.modules.Accounts).toEqual([]);
    expect(s.overrides.Account).toEqual({ read: 'grant' });
    expect(s.overrides.AuditLog).toBeUndefined();
  });

  it('leaves other modules and their overrides untouched', () => {
    const s = collapseFullyDeniedModules(
      state({
        modules: { Accounts: ['read'], IAM: ['read'] },
        overrides: {
          Account: { read: 'deny' },
          AuditLog: { read: 'deny' },
          Role: { read: 'deny' },
        },
      }),
      { Accounts: ACCOUNTS_SUBJECTS, IAM: IAM_SUBJECTS }
    );

    expect(s.modules.Accounts).toEqual([]);
    // User never denied read, so IAM keeps its grant and Role keeps its deny.
    expect(s.modules.IAM).toEqual(['read']);
    expect(cellState(s, 'Role', 'read')).toBe('deny');
  });

  it('is a no-op on a state with nothing to collapse', () => {
    const before = state({ modules: { Accounts: ['read'] }, overrides: {} });
    expect(collapseFullyDeniedModules(before, { Accounts: ACCOUNTS_SUBJECTS })).toEqual(before);
  });

  // A grant-driven collapse would be wrong: an explicit grant on every subject
  // means everyone HAS the verb, so the module must stay checked.
  it('does not collapse when every subject explicitly grants the verb', () => {
    const s = collapseFullyDeniedModules(
      state({
        modules: { Accounts: ['read'] },
        overrides: { Account: { read: 'grant' }, AuditLog: { read: 'grant' } },
      }),
      { Accounts: ACCOUNTS_SUBJECTS }
    );
    expect(s.modules.Accounts).toEqual(['read']);
  });
});

describe('collapse wired to toggleSubject', () => {
  // Denying the LAST still-inherited subject is the click that empties the
  // module, and the collapse must land on that same click — not one click later.
  it('the click that denies the final subject unchecks the module', () => {
    let s = toggleSubject(
      state({ modules: { Accounts: ['read'] } }),
      'Accounts',
      'Account',
      'read',
      grantableAlways,
      ACCOUNTS_SUBJECTS
    );
    s = collapseFullyDeniedModules(
      toggleSubject(s, 'Accounts', 'AuditLog', 'read', grantableAlways, ACCOUNTS_SUBJECTS),
      { Accounts: ACCOUNTS_SUBJECTS }
    );

    expect(s.modules.Accounts).toEqual([]);
    expect(s.overrides.Account).toBeUndefined();
    expect(s.overrides.AuditLog).toBeUndefined();
  });

  // Round-trip guard. The collapse must not fight the lift: granting a subject
  // back lifts the module again and protects the sibling, exactly as before.
  it('a grant after a collapse lifts the module again without widening', () => {
    let s = collapseFullyDeniedModules(
      state({
        modules: { Accounts: [...['create', 'read', 'update', 'delete']] },
        overrides: {
          Account: { create: 'deny', read: 'deny', update: 'deny', delete: 'deny' },
          AuditLog: { create: 'deny', read: 'deny', update: 'deny', delete: 'deny' },
        },
      }),
      { Accounts: ACCOUNTS_SUBJECTS }
    );
    s = toggleSubject(s, 'Accounts', 'Account', 'read', grantableAlways, ACCOUNTS_SUBJECTS);

    expect(s.modules.Accounts).toEqual(['read']);
    expect(effectiveChecked(s, 'Accounts', 'Account', 'read')).toBe(true);
    expect(effectiveChecked(s, 'Accounts', 'AuditLog', 'read')).toBe(false);
  });
});

describe('resetSubject', () => {
  it('drops every override for one subject', () => {
    const s = resetSubject(
      state({ overrides: { Provider: { read: 'deny' }, Agent: { read: 'grant' } } }),
      'Provider'
    );
    expect(s.overrides.Provider).toBeUndefined();
    expect(s.overrides.Agent).toEqual({ read: 'grant' });
  });
});

describe('toPayload', () => {
  it('round-trips through toMatrixState unchanged', () => {
    const permissions = { AIOps: ['read', 'update'] };
    const overrides = { Provider: { grant: [], deny: ['update'] } };
    const { state: s, carried } = toMatrixState(permissions, overrides, MODULE_KEYS, SUBJECT_KEYS, COLUMN_KEYS);

    const payload = toPayload(s, carried);

    expect(payload.permissions.AIOps.sort()).toEqual(['read', 'update']);
    expect(payload.overrides).toEqual({ Provider: { grant: [], deny: ['update'] } });
  });

  it('merges carried grants back in verbatim', () => {
    const { state: s, carried } = toMatrixState(
      { AIOps: ['read'], GhostModule: ['delete'] },
      { GhostSubject: { grant: ['read'], deny: [] } },
      MODULE_KEYS,
      SUBJECT_KEYS,
      COLUMN_KEYS
    );

    const payload = toPayload(s, carried);

    expect(payload.permissions.GhostModule).toEqual(['delete']);
    expect(payload.overrides.GhostSubject).toEqual({ grant: ['read'], deny: [] });
  });
});

describe('hasAnyPermission', () => {
  it('is false for an empty role', () => {
    expect(hasAnyPermission(state(), { modules: {}, overrides: {} })).toBe(false);
  });

  it('is true when only a carried grant exists', () => {
    expect(hasAnyPermission(state(), { modules: { Ghost: ['read'] }, overrides: {} })).toBe(true);
  });

  // A role made only of denials grants nothing and must not save.
  it('is false when the only overrides are denials', () => {
    expect(hasAnyPermission(state({ overrides: { Provider: { read: 'deny' } } }), { modules: {}, overrides: {} })).toBe(false);
  });

  it('is true when a subject grant exists with no module grant', () => {
    expect(hasAnyPermission(state({ overrides: { Provider: { read: 'grant' } } }), { modules: {}, overrides: {} })).toBe(true);
  });
});

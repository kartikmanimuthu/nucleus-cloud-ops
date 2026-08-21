// @vitest-environment jsdom
//
// Declared per-file — see hooks/__tests__/use-can.test.tsx and
// components/rbac/__tests__/gated.test.tsx: Vitest 4 removed
// environmentMatchGlobs, so vitest.config.ts's jsdom glob is inert.

/**
 * The grid must be the registry's shape, not a copy of it. These tests pin the
 * ways the old hardcoded arrays could drift from the database: a module that
 * exists only in the registry, a verb column that only some modules grant, a
 * cell the registry says is not grantable, an alias verb that IS grantable
 * somewhere but must still not get a column, a module whose grantable cells
 * exclude read (Rule 1 must not imply it), and a stored verb with no column
 * inside a module that does have a row (Rule 2 must not silently drop it).
 *
 * A second block below pins the two-level grid added on top of that: a
 * module's submodules stay collapsed until expanded, a subject inherits its
 * module's cell until overridden, an override earns a badge on the collapsed
 * module row, and Save carries `overrides` alongside `permissions`.
 *
 * No jest-dom in this repo's Vitest setup (see other component __tests__
 * dirs), so assertions read raw DOM properties/queries rather than
 * toBeInTheDocument()/toBeDisabled().
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const meta = {
  modules: [
    { key: "Accounts", label: "Accounts", icon: null, navPath: null, sortOrder: 10 },
    { key: "CostControl", label: "Cost Control", icon: null, navPath: null, sortOrder: 70 },
    // Grants Update but not Read — isolates Rule 1 (checking a non-read verb
    // must not imply Read when Read isn't grantable for this module at all).
    { key: "Billing", label: "Billing", icon: null, navPath: null, sortOrder: 80 },
  ],
  actions: [
    { key: "read", label: "Read", aliasOfKey: null, isDangerous: false },
    { key: "delete", label: "Delete", aliasOfKey: null, isDangerous: true },
    { key: "update", label: "Update", aliasOfKey: null, isDangerous: false },
    // `execute` IS granted to Accounts below (so `grantedVerbs.has('execute')`
    // is true) AND carries an aliasOfKey — only the alias clause in the
    // column filter can exclude it. Without that isolation, a fixture where
    // the alias verb was simply never granted anywhere would pass whether or
    // not the alias check existed at all.
    { key: "execute", label: "Execute", aliasOfKey: "update", isDangerous: true },
  ],
  moduleActions: [
    { moduleKey: "Accounts", actionKey: "read" },
    { moduleKey: "Accounts", actionKey: "delete" },
    { moduleKey: "Accounts", actionKey: "execute" },
    { moduleKey: "CostControl", actionKey: "read" },
    { moduleKey: "Billing", actionKey: "update" },
  ],
  // TWO subjects hang off Accounts so the two-level tests below have something
  // to expand into. Two, not one, is load-bearing: collapseFullyDeniedModules
  // unchecks a module once EVERY rendered subject denies a verb, so on a
  // one-subject fixture a single deny would collapse the module and the
  // override-badge/deny-rendering tests would be pinning the collapse instead
  // of what they mean to pin. Two rows keeps one subject inheriting, which is
  // also the real shape — no seeded module renders exactly one submodule
  // (Accounts has 2, Inventory 4, Dashboard 0). The collapse itself is pinned
  // deliberately in its own block at the bottom.
  //
  // CostControl/Billing are left subject-less, which is also what pins the "no
  // chevron for a module with zero submodules" behaviour used by the
  // single-level tests above.
  subjects: [
    { key: "AccountGroup", label: "Account Group", kind: "Subject", moduleKey: "Accounts", navPath: null, sortOrder: 10 },
    { key: "AccountAudit", label: "Account Audit", kind: "Subject", moduleKey: "Accounts", navPath: null, sortOrder: 20 },
    // Both in HIDDEN_SUBJECT_KEYS. Note `kind` is an ordinary subject kind and
    // navPath is null exactly like the two rows above — nothing in the registry
    // distinguishes them, which is why the hide rule is a key list. If either row
    // ever starts rendering, the list stopped being applied.
    { key: "Discovery", label: "Discovery Run", kind: "Subject", moduleKey: "Accounts", navPath: null, sortOrder: 30 },
    { key: "Billing", label: "Billing", kind: "Subject", moduleKey: "Accounts", navPath: null, sortOrder: 40 },
  ],
  actionAliases: { execute: "update" },
  version: "1.0",
  isLoaded: true,
};

vi.mock("@/hooks/use-can", () => ({
  useAbilityMeta: () => meta,
  useGrantableCells: () => meta.moduleActions,
}));

import { RoleDialog } from "../role-dialog";

const noop = async () => {};

describe("RoleDialog", () => {
  it("renders a row for every registry module, including new ones", () => {
    render(<RoleDialog open onOpenChange={noop} role={null} onSave={noop} />);
    expect(screen.getByText("Cost Control")).toBeTruthy();
  });

  it("renders a column for every verb that some module grants", () => {
    render(<RoleDialog open onOpenChange={noop} role={null} onSave={noop} />);
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
  });

  it("omits alias verbs, which resolve to their target at compile time", () => {
    render(<RoleDialog open onOpenChange={noop} role={null} onSave={noop} />);
    expect(screen.queryByText("Execute")).toBeNull();
  });

  it("disables a cell the registry does not make grantable", () => {
    render(<RoleDialog open onOpenChange={noop} role={null} onSave={noop} />);
    const cell = screen.getByRole("checkbox", { name: "Delete Cost Control" }) as HTMLButtonElement;
    expect(cell.disabled).toBe(true);
  });

  it("keeps a grant whose module has left the registry, so saving does not silently revoke it", async () => {
    const onSave = vi.fn<(name: string, permissions: Record<string, string[]>, overrides: unknown) => Promise<void>>(async () => {});
    render(
      <RoleDialog
        open
        onOpenChange={noop}
        role={{ id: "r1", name: "Ops", permissions: { Accounts: ["read"], Retired: ["read"] } }}
        onSave={onSave}
      />
    );
    screen.getByRole("button", { name: "Save Role" }).click();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][1]).toMatchObject({ Accounts: ["read"], Retired: ["read"] });
  });

  it("does not auto-check Read when the module does not make Read grantable (Rule 1 must not write an ungranted cell)", async () => {
    const onSave = vi.fn<(name: string, permissions: Record<string, string[]>, overrides: unknown) => Promise<void>>(async () => {});
    render(
      <RoleDialog
        open
        onOpenChange={noop}
        role={{ id: "r2", name: "Billing Ops", permissions: {} }}
        onSave={onSave}
      />
    );

    // Billing only grants Update (see moduleActions above) — Read has no
    // cell for it at all, so its checkbox must render disabled.
    const readCell = screen.getByRole("checkbox", { name: "Read Billing" }) as HTMLButtonElement;
    expect(readCell.disabled).toBe(true);

    const updateCell = screen.getByRole("checkbox", { name: "Update Billing" }) as HTMLButtonElement;
    fireEvent.click(updateCell);
    fireEvent.click(screen.getByRole("button", { name: "Save Role" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());

    // Only the tick the operator actually made — no implied Read the grid
    // never offered as grantable for Billing.
    expect(onSave.mock.calls[0][1].Billing).toEqual(["update"]);
  });

  it("keeps a stored verb with no column when Read is unchecked (Rule 2 only clears what the grid shows)", async () => {
    const onSave = vi.fn<(name: string, permissions: Record<string, string[]>, overrides: unknown) => Promise<void>>(async () => {});
    render(
      <RoleDialog
        open
        onOpenChange={noop}
        // `execute` is stored for Accounts but has no column (it's an
        // alias) — a verb the grid cannot show, inside a module the grid
        // DOES show. Unchecking Read must not sweep it away too.
        role={{ id: "r3", name: "Accounts Ops", permissions: { Accounts: ["read", "execute"] } }}
        onSave={onSave}
      />
    );

    const readCell = screen.getByRole("checkbox", { name: "Read Accounts" }) as HTMLButtonElement;
    fireEvent.click(readCell); // uncheck Read -> Rule 2 clears the module's VISIBLE verbs
    fireEvent.click(screen.getByRole("button", { name: "Save Role" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());

    expect(onSave.mock.calls[0][1].Accounts).toEqual(["execute"]);
  });

  describe("two-level matrix (submodules)", () => {
    it("keeps a module's submodules collapsed until its chevron is expanded", () => {
      render(<RoleDialog open onOpenChange={noop} role={null} onSave={noop} />);
      // Collapsed by default: the subject row is not on screen at all.
      expect(screen.queryByText("Account Group")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Expand Accounts submodules" }));
      expect(screen.getByText("Account Group")).toBeTruthy();
    });

    it("shows a submodule cell as checked-and-inherited when only the module is granted", () => {
      render(
        <RoleDialog
          open
          onOpenChange={noop}
          role={{ id: "r4", name: "Accounts Ops", permissions: { Accounts: ["read"] } }}
          onSave={noop}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Expand Accounts submodules" }));

      const subjectRead = screen.getByRole("checkbox", {
        name: "Read Account Group (inherit)",
      }) as HTMLInputElement;
      expect(subjectRead.getAttribute("data-state")).toBe("checked");
    });

    it("overriding a submodule's inherited Read denies it, badges the module row, and Reset restores inherit", async () => {
      const onSave = vi.fn<
        (name: string, permissions: Record<string, string[]>, overrides: Record<string, { grant: string[]; deny: string[] }>) => Promise<void>
      >(async () => {});
      render(
        <RoleDialog
          open
          onOpenChange={noop}
          role={{ id: "r5", name: "Accounts Ops", permissions: { Accounts: ["read"] } }}
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Expand Accounts submodules" }));

      // Module currently has no override badge.
      expect(screen.queryByText("1 override")).toBeNull();

      fireEvent.click(screen.getByRole("checkbox", { name: "Read Account Group (inherit)" }));

      // Deny wins: the cell is now unchecked despite the module granting Read,
      // and the collapsed-module badge surfaces the exception.
      const denied = screen.getByRole("checkbox", {
        name: "Read Account Group (deny)",
      }) as HTMLInputElement;
      expect(denied.getAttribute("data-state")).toBe("unchecked");
      expect(screen.getByText("1 override")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Save Role" }));
      await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onSave.mock.calls[0][2]).toMatchObject({
        AccountGroup: { grant: [], deny: ["read"] },
      });

      // Reset clears the override and the badge, back to plain inheritance.
      fireEvent.click(screen.getByRole("button", { name: "Reset Account Group to inherited" }));
      expect(screen.queryByText("1 override")).toBeNull();
      const restored = screen.getByRole("checkbox", {
        name: "Read Account Group (inherit)",
      }) as HTMLInputElement;
      expect(restored.getAttribute("data-state")).toBe("checked");
    });

    it("a role opened with a stored subject override renders it pre-applied", () => {
      render(
        <RoleDialog
          open
          onOpenChange={noop}
          role={{
            id: "r6",
            name: "Accounts Ops",
            permissions: { Accounts: ["read"] },
            overrides: { AccountGroup: { grant: [], deny: ["read"] } },
          }}
          onSave={noop}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Expand Accounts submodules" }));
      expect(screen.getByText("1 override")).toBeTruthy();
      const denied = screen.getByRole("checkbox", {
        name: "Read Account Group (deny)",
      }) as HTMLInputElement;
      expect(denied.getAttribute("data-state")).toBe("unchecked");
    });
  });

  /**
   * Hidden subjects fall under their module's checkbox. The property that
   * matters is that hiding a row does not silently REVOKE what it held: it
   * leaves the registry's "known" set, so toMatrixState routes it to `carried`
   * and toPayload writes it back verbatim — the same choice 2112742 made for the
   * catch-alls rather than deleting the rows.
   */
  describe("subjects in HIDDEN_SUBJECT_KEYS", () => {
    it("renders no row, even expanded", () => {
      render(<RoleDialog open onOpenChange={noop} role={null} onSave={noop} />);
      fireEvent.click(screen.getByRole("button", { name: "Expand Accounts submodules" }));

      expect(screen.getByText("Account Group")).toBeTruthy();
      expect(screen.queryByText("Discovery Run")).toBeNull();

      // Asserted via the subject-row checkbox, not the label text: the fixture
      // also has a MODULE keyed 'Billing' (see the Rule 1 test above), so
      // queryByText('Billing') matches that module row and would pass whether or
      // not the subject were hidden. Subject cells are labelled
      // "<Verb> <Subject> (<state>)", which only a rendered subject row produces.
      expect(screen.queryByRole("checkbox", { name: /^Read Billing \(/ })).toBeNull();
      expect(screen.queryByRole("checkbox", { name: /^Read Discovery Run \(/ })).toBeNull();
      // Control: the visible sibling's cell IS found by that same pattern, so the
      // two assertions above are not passing on a bad locator.
      expect(screen.getByRole("checkbox", { name: /^Read Account Group \(/ })).toBeTruthy();
    });

    it("preserves an existing override on it through a save", async () => {
      const onSave = vi.fn<
        (name: string, permissions: Record<string, string[]>, overrides: Record<string, { grant: string[]; deny: string[] }>) => Promise<void>
      >(async () => {});
      render(
        <RoleDialog
          open
          onOpenChange={noop}
          role={{
            id: "r9",
            name: "Accounts Ops",
            permissions: { Accounts: ["read"] },
            overrides: { Discovery: { grant: [], deny: ["read"] } },
          }}
          onSave={onSave}
        />
      );

      // No row to badge it, so nothing on screen reports the exception.
      expect(screen.queryByText("1 override")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Save Role" }));
      await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onSave.mock.calls[0][2]).toMatchObject({ Discovery: { grant: [], deny: ["read"] } });
    });
  });

  /**
   * The module row must never claim a grant that reaches nobody. Once every
   * rendered submodule denies a verb, the module checkbox has to say so too.
   * Unit coverage for the rule itself lives in
   * permission-matrix/__tests__/use-matrix-state.test.ts; these two pin the
   * WIRING, which is the part that fails silently — an effect that forgets to
   * normalize, or a toggle handler that drops the collapse.
   */
  describe("module unchecks itself when every submodule is denied", () => {
    it("normalizes a role already SAVED in that state, on open", () => {
      render(
        <RoleDialog
          open
          onOpenChange={noop}
          role={{
            id: "r7",
            name: "Accounts Ops",
            permissions: { Accounts: ["read"] },
            overrides: {
              AccountGroup: { grant: [], deny: ["read"] },
              AccountAudit: { grant: [], deny: ["read"] },
            },
          }}
          onSave={noop}
        />
      );

      // The reported bug: this used to render checked with a "2 overrides"
      // badge while authorizing nobody.
      const moduleRead = screen.getByRole("checkbox", { name: "Read Accounts" }) as HTMLInputElement;
      expect(moduleRead.getAttribute("data-state")).toBe("unchecked");
      expect(screen.queryByText("2 overrides")).toBeNull();

      // Both denies dropped, so the rows read as plain inherit rather than
      // carrying a badge for an exception to a grant that no longer exists.
      fireEvent.click(screen.getByRole("button", { name: "Expand Accounts submodules" }));
      expect(screen.getByRole("checkbox", { name: "Read Account Group (inherit)" })).toBeTruthy();

      // Documented consequence: normalizing on open can disable Save before the
      // operator touches anything. Correct — the role really did grant nothing.
      expect((screen.getByRole("button", { name: "Save Role" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("collapses on the click that denies the last still-inherited submodule", () => {
      render(
        <RoleDialog
          open
          onOpenChange={noop}
          role={{ id: "r8", name: "Accounts Ops", permissions: { Accounts: ["read"] } }}
          onSave={noop}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Expand Accounts submodules" }));

      fireEvent.click(screen.getByRole("checkbox", { name: "Read Account Group (inherit)" }));
      // One down, one to go — the module still grants Read to Account Audit.
      expect(
        (screen.getByRole("checkbox", { name: "Read Accounts" }) as HTMLInputElement).getAttribute("data-state")
      ).toBe("checked");

      fireEvent.click(screen.getByRole("checkbox", { name: "Read Account Audit (inherit)" }));
      // That was the last one: the module unchecks on this very click, and both
      // now-redundant denies drop with it.
      expect(
        (screen.getByRole("checkbox", { name: "Read Accounts" }) as HTMLInputElement).getAttribute("data-state")
      ).toBe("unchecked");
      expect(screen.queryByText("2 overrides")).toBeNull();
      expect(screen.getByRole("checkbox", { name: "Read Account Group (inherit)" })).toBeTruthy();
    });
  });
}, 30000);

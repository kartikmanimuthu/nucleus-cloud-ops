import { expect, test } from '@playwright/test';

/**
 * Round-trips a submodule override through the real editor.
 *
 * Deliberately does NOT sign in as the restricted role: creating a user,
 * assigning a role and re-authenticating inside a Playwright run is slow and the
 * flakiest part of any suite here. Nav hiding and page admission are covered by
 * use-nav-gate.test.tsx and page-authz.test.ts, which test the same resolver
 * this UI feeds. What only an E2E can prove is that the two-level grid persists
 * what it displays.
 *
 * Selectors verified against the real implementation (not the brief's planned
 * shape):
 * - Roles render as Cards (components/settings/roles-list.tsx), not <table>
 *   rows, so there is no `getByRole('row', ...)` to key off. The Edit button's
 *   accessible name is `Edit ${role.name}` (RoleCard's GatedButton
 *   `aria-label={\`Edit ${role.name}\`}`), which is unique enough on its own —
 *   ROLE_NAME is timestamp-suffixed and no other role can collide with it.
 * - Module checkbox aria-label is `${col.label} ${moduleLabel}` (module-row.tsx)
 *   -> "Read AI Ops". Matches the brief.
 * - Expand/collapse button aria-label is
 *   `${expanded ? "Collapse" : "Expand"} ${moduleLabel} submodules`
 *   (module-row.tsx) -> "Expand AI Ops submodules". Matches the brief.
 * - Subject checkbox aria-label is `${col.label} ${subjectLabel} (${cell})`
 *   (subject-row.tsx), where `cell` is "inherit" | "grant" | "deny" and changes
 *   as the box is toggled -> "Read LLM Provider (inherit)" then
 *   "Read LLM Provider (deny)". The brief's `/^Read LLM Provider/` prefix regex
 *   survives that state change, so it is kept as-is.
 * - The override badge text is `${overriddenCount} override${overriddenCount === 1 ? "" : "s"}`
 *   (module-row.tsx) -> exactly "1 override" for a single override. Matches the
 *   brief.
 * - Subject "Provider" (label "LLM Provider") is confirmed seeded under module
 *   "AIOps" (label "AI Ops") with `read` grantable, in
 *   libs/prisma/migrations/20260812100000_subject_nav_paths/migration.sql and
 *   20260730000000_dynamic_abac/migration.sql.
 */

const ROLE_NAME = `E2E Submodule ${Date.now()}`;

test.describe('Submodule permissions', () => {
    test.afterAll(async ({ request }) => {
        // The spec leaves a custom role behind. MAX_CUSTOM_ROLES = 10 per tenant
        // (lib/rbac/custom-role-service.ts), so an orphaned role from a run
        // eventually breaks unrelated future runs — clean it up by name lookup
        // since the create flow doesn't hand the test the new role's id.
        const res = await request.get('/api/settings/roles');
        if (!res.ok()) return;
        const json = await res.json();
        const match = (json?.data?.custom ?? []).find(
            (r: { id: string; name: string }) => r.name === ROLE_NAME
        );
        if (match) {
            await request.delete(`/api/settings/roles/${match.id}`);
        }
    });

    test('creates a role with a subject override and reloads it', async ({ page }) => {
        await page.goto('/app/iam/roles');
        await page.waitForLoadState('networkidle');

        await page.getByRole('button', { name: 'Create Role' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();

        await page.getByLabel('Role Name').fill(ROLE_NAME);

        // Grant the whole module first.
        await page.getByRole('checkbox', { name: 'Read AI Ops' }).click();

        // Expand AI Ops and deny one submodule.
        await page.getByRole('button', { name: 'Expand AI Ops submodules' }).click();
        const providerRead = page.getByRole('checkbox', { name: /^Read LLM Provider/ });
        await expect(providerRead).toBeChecked(); // inherited from the module
        await providerRead.click();
        await expect(providerRead).not.toBeChecked();

        // The override is announced on the module row even before saving.
        await expect(page.getByText('1 override')).toBeVisible();

        await page.getByRole('button', { name: 'Save Role' }).click();
        await expect(page.getByRole('dialog')).toBeHidden();

        // Reopen and confirm the override survived the round-trip. Roles render
        // as Cards (roles-list.tsx), not table rows, so the Edit control is
        // found directly by its accessible name rather than via a row locator.
        await page.getByRole('button', { name: `Edit ${ROLE_NAME}` }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByRole('button', { name: 'Expand AI Ops submodules' }).click();
        await expect(page.getByRole('checkbox', { name: /^Read LLM Provider/ })).not.toBeChecked();
        await expect(page.getByRole('checkbox', { name: 'Read AI Ops' })).toBeChecked();
    });
});

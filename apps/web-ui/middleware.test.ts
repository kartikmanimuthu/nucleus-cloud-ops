/**
 * FINDING 4: the page guard (enforcePageRead) must reason about the SAME set
 * of modules the client-facing /api/me/ability payload ships — enabled
 * modules only. Before the fix, enforcePageRead passed `registry.modules`
 * RAW (unfiltered) into resolveNavOwner, while /api/me/ability filters with
 * `registry.modules.filter(m => m.enabled)`. Masked today because every
 * seeded module's navPath is exactly duplicated by a subject's navPath (the
 * subject wins the length tie), but disabling a module via
 * PATCH /api/settings/rbac/modules/[moduleId] could make the sidebar
 * (filtered) and the page guard (unfiltered) disagree about whether that
 * module's pages are reachable.
 *
 * This test spies on the shared resolver (`resolveNavOwner`, from
 * @nucleus/rbac — the exact function both the client payload route and this
 * middleware feed) and asserts the `modules` argument enforcePageRead passes
 * it excludes disabled modules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequestWithAuth } from 'next-auth/middleware';
import type { RegistrySnapshot } from '@nucleus/rbac';

// enforcePageRead never touches next-auth's withAuth wrapper directly, but
// middleware.ts calls withAuth(...) at module scope for its default export.
// Stubbed so importing the module under test never depends on a real
// NextAuth runtime.
vi.mock('next-auth/middleware', () => ({
    withAuth: vi.fn(() => vi.fn()),
}));

vi.mock('@/lib/rbac/ability-cache', () => ({
    getAbilityForPrincipal: vi.fn(),
    getCachedRegistrySnapshot: vi.fn(),
    getRbacVersion: vi.fn(),
}));

vi.mock('@/lib/rbac/session-ability', () => ({
    buildPrincipalFor: vi.fn(),
}));

// Wrap the REAL resolveNavOwner as a spy rather than replacing it — the
// point of this test is to observe what middleware.ts hands to the actual
// shared resolver, not to fake its behavior.
vi.mock('@nucleus/rbac', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@nucleus/rbac')>();
    return { ...actual, resolveNavOwner: vi.fn(actual.resolveNavOwner) };
});

import { enforcePageRead } from './middleware';
import { getAbilityForPrincipal, getCachedRegistrySnapshot } from '@/lib/rbac/ability-cache';
import { buildPrincipalFor } from '@/lib/rbac/session-ability';
import { resolveNavOwner } from '@nucleus/rbac';

const mockGetAbility = vi.mocked(getAbilityForPrincipal);
const mockGetRegistry = vi.mocked(getCachedRegistrySnapshot);
const mockBuildPrincipal = vi.mocked(buildPrincipalFor);
const mockResolveNavOwner = vi.mocked(resolveNavOwner);

function fakeRequest(pathname: string): NextRequestWithAuth {
    return {
        nextUrl: { pathname },
        nextauth: {
            token: {
                sub: 'u1',
                email: 'u1@example.com',
                tenantId: 't1',
                role: 'Ops',
                isSuperAdmin: false,
            },
        },
    } as unknown as NextRequestWithAuth;
}

function registryWithMixedModules(): RegistrySnapshot {
    return {
        tenantId: 't1',
        modules: [
            {
                id: 'm-inv',
                tenantId: null,
                key: 'Inventory',
                label: 'Inventory',
                description: null,
                icon: null,
                navPath: '/app/inventory',
                sortOrder: 1,
                isSystem: true,
                enabled: true,
            },
            {
                id: 'm-bill',
                tenantId: null,
                key: 'Billing',
                label: 'Billing',
                description: null,
                icon: null,
                navPath: '/app/billing',
                sortOrder: 2,
                isSystem: true,
                enabled: false, // admin disabled this module
            },
        ],
        actions: [],
        subjects: [],
        subjectModules: [],
        moduleActions: [],
        subjectAttributes: [],
        principalAttributes: [],
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    process.env.RBAC_PAGE_GUARD_MODE = 'shadow';

    mockBuildPrincipal.mockResolvedValue({
        userId: 'u1',
        email: 'u1@example.com',
        tenantId: 't1',
        roleId: 'role-1',
        roleName: 'Ops',
        level: 2,
        isSuperAdmin: false,
        attributes: {},
    });
    mockGetRegistry.mockResolvedValue(registryWithMixedModules());
    // ability.can always true — this test is about what gets PASSED to
    // resolveNavOwner, not about the allow/deny decision downstream of it.
    mockGetAbility.mockResolvedValue({
        ability: { can: () => true } as never,
        dropped: [],
        version: '0.0',
        actionAliases: {},
    });
});

afterEach(() => {
    delete process.env.RBAC_PAGE_GUARD_MODE;
});

describe('enforcePageRead — module filtering parity with /api/me/ability (Finding 4)', () => {
    it('excludes a disabled module from the modules array passed to resolveNavOwner', async () => {
        await enforcePageRead(fakeRequest('/app/inventory'));

        expect(mockResolveNavOwner).toHaveBeenCalledOnce();
        const modulesArg = mockResolveNavOwner.mock.calls[0][2] as { key: string; enabled?: boolean }[];

        expect(modulesArg.map((m) => m.key)).toContain('Inventory');
        expect(modulesArg.map((m) => m.key)).not.toContain('Billing');
        expect(modulesArg.every((m) => m.enabled !== false)).toBe(true);
    });
});

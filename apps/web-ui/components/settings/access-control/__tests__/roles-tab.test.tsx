// @vitest-environment jsdom
import React from 'react';
import { createMongoAbility } from '@casl/ability';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppAbility } from '@nucleus/rbac';
import { AbilityProvider as CaslAbilityProvider } from '@casl/react';
import { AbilityMetaContext, type AbilityMeta } from '@/providers/ability-provider';
import { RolesTab } from '../roles-tab';

vi.mock('@/lib/queries/roles', () => ({
    useRoles: () => ({ data: { predefined: [], custom: [] }, isLoading: false, error: null }),
    useSaveRole: () => ({ mutateAsync: vi.fn() }),
    useDeleteRole: () => ({ mutateAsync: vi.fn() }),
}));

function wrapperFor(ability: AppAbility) {
    const value: AbilityMeta = {
        modules: [], actions: [], subjects: [], moduleActions: [],
        actionAliases: {}, version: '1.1', isLoaded: true,
    };
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <CaslAbilityProvider value={ability}>
                <AbilityMetaContext.Provider value={value}>{children}</AbilityMetaContext.Provider>
            </CaslAbilityProvider>
        );
    };
}

describe('RolesTab — Create Role gating', () => {
    it('disables Create Role when the user cannot create Role', () => {
        const ability = createMongoAbility([]) as AppAbility;
        render(<RolesTab />, { wrapper: wrapperFor(ability) });

        const btn = screen.getByRole('button', { name: /create role/i }) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
    });

    it('enables Create Role when the user can create Role', () => {
        const ability = createMongoAbility([{ action: 'create', subject: 'Role' }]) as AppAbility;
        render(<RolesTab />, { wrapper: wrapperFor(ability) });

        const btn = screen.getByRole('button', { name: /create role/i }) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
    });
});

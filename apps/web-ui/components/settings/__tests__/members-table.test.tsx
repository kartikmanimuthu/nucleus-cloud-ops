// @vitest-environment jsdom
import React from 'react';
import { createMongoAbility } from '@casl/ability';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppAbility } from '@nucleus/rbac';
import { AbilityProvider as CaslAbilityProvider } from '@casl/react';
import { AbilityMetaContext, type AbilityMeta } from '@/providers/ability-provider';
import { MembersTable } from '../members-table';

// MembersTable always mounts MemberAttributesDialog (open or not), and that
// dialog calls useQuery/useMemberAttributes unconditionally — it just passes
// a null memberId when closed. useQuery still needs an ambient QueryClient
// even when disabled, so the wrapper provides one here.
function wrapperFor(ability: AppAbility) {
    const value: AbilityMeta = {
        modules: [], actions: [], subjects: [], moduleActions: [],
        actionAliases: {}, version: '1.1', isLoaded: true,
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <QueryClientProvider client={client}>
                <CaslAbilityProvider value={ability}>
                    <AbilityMetaContext.Provider value={value}>{children}</AbilityMetaContext.Provider>
                </CaslAbilityProvider>
            </QueryClientProvider>
        );
    };
}

const member = {
    id: 'm1', userId: 'u1', email: 'a@example.com', role: 'Member', assignedAt: '2026-01-01',
};

// Both the role Select and the Edit attributes button gate on the same
// (update, User) pair — attributes moved off the generic `Settings` subject
// onto `User` when Member/Role management moved into the IAM module, so
// there is no longer a grant that separates the two controls.
describe('MembersTable gating', () => {
    it('disables the role Select and Edit attributes when the user cannot update User', () => {
        const ability = createMongoAbility([]) as AppAbility;
        render(
            <MembersTable
                members={[member]}
                loading={false}
                error={null}
                currentUserId="someone-else"
                availableRoles={['Member', 'Admin']}
                onRoleChange={vi.fn()}
            />,
            { wrapper: wrapperFor(ability) },
        );

        expect((screen.getByRole('combobox') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: /edit attributes/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables both controls when the user can update User', () => {
        const ability = createMongoAbility([{ action: 'update', subject: 'User' }]) as AppAbility;
        render(
            <MembersTable
                members={[member]}
                loading={false}
                error={null}
                currentUserId="someone-else"
                availableRoles={['Member', 'Admin']}
                onRoleChange={vi.fn()}
            />,
            { wrapper: wrapperFor(ability) },
        );

        expect((screen.getByRole('combobox') as HTMLButtonElement).disabled).toBe(false);
        expect((screen.getByRole('button', { name: /edit attributes/i }) as HTMLButtonElement).disabled).toBe(false);
    });
});

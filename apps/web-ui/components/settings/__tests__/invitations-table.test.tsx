// @vitest-environment jsdom
import React from 'react';
import { createMongoAbility } from '@casl/ability';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppAbility } from '@nucleus/rbac';
import { AbilityProvider as CaslAbilityProvider } from '@casl/react';
import { AbilityMetaContext, type AbilityMeta } from '@/providers/ability-provider';
import { InvitationsTable } from '../invitations-table';

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

const invitation = {
    id: 'inv1', tenantId: 't1', email: 'b@example.com', role: 'Member',
    invitedBy: 'u1', status: 'pending' as const, createdAt: '2026-01-01', expiresAt: '2026-02-01',
};

describe('InvitationsTable gating', () => {
    it('disables Resend and Revoke when the user has no grants', () => {
        const ability = createMongoAbility([]) as AppAbility;
        render(
            <InvitationsTable
                invitations={[invitation]}
                loading={false}
                error={null}
                onResend={vi.fn()}
                onRevoke={vi.fn()}
            />,
            { wrapper: wrapperFor(ability) },
        );

        expect((screen.getByRole('button', { name: /resend/i }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: /revoke/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables Resend and Revoke independently based on update vs delete User', () => {
        const ability = createMongoAbility([{ action: 'update', subject: 'User' }]) as AppAbility;
        render(
            <InvitationsTable
                invitations={[invitation]}
                loading={false}
                error={null}
                onResend={vi.fn()}
                onRevoke={vi.fn()}
            />,
            { wrapper: wrapperFor(ability) },
        );

        expect((screen.getByRole('button', { name: /resend/i }) as HTMLButtonElement).disabled).toBe(false);
        expect((screen.getByRole('button', { name: /revoke/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables Revoke when the user holds delete User', () => {
        const ability = createMongoAbility([{ action: 'delete', subject: 'User' }]) as AppAbility;
        render(
            <InvitationsTable
                invitations={[invitation]}
                loading={false}
                error={null}
                onResend={vi.fn()}
                onRevoke={vi.fn()}
            />,
            { wrapper: wrapperFor(ability) },
        );

        expect((screen.getByRole('button', { name: /resend/i }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: /revoke/i }) as HTMLButtonElement).disabled).toBe(false);
    });
});

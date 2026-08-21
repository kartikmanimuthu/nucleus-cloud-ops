// @vitest-environment jsdom

/**
 * The starter cards on a fresh session.
 *
 * They only PREFILL the composer, so it is tempting to leave them ungated — the
 * composer is already disabled for a caller without `create Agent`, and nothing
 * can be sent. But a card that lights up on hover and accepts a click while
 * nothing can come of it reads as a broken app, not as a permission boundary.
 * These tests pin that the cards follow the same grant the send path does.
 */

import React from 'react';
import { createMongoAbility } from '@casl/ability';
import { AbilityProvider as CaslAbilityProvider } from '@casl/react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppAbility } from '@nucleus/rbac';

import { AbilityMetaContext, type AbilityMeta } from '@/providers/ability-provider';
import { EmptyState } from '../empty-state';

// `Agent`, not `AIOps`: POST /api/chat declares subject Agent, and compiled rules
// never carry a module key as their subject.
const WRITER = createMongoAbility([{ action: 'create', subject: 'Agent' }]) as AppAbility;
const READER = createMongoAbility([{ action: 'read', subject: 'Agent' }]) as AppAbility;

function renderEmptyState(ability: AppAbility, onSuggestion = vi.fn()) {
    const meta: AbilityMeta = {
        modules: [{ key: 'AIOps', label: 'AI Ops', icon: null, navPath: '/app/agent', sortOrder: 40 }],
        actions: [],
        subjects: [{ key: 'Agent', label: 'Agent', kind: 'capability', moduleKey: 'AIOps' }],
        // Required on AbilityMeta since the grantable cells began riding
        // along with the ability payload. Empty: these tests are not about the
        // role grid.
        moduleActions: [],
        actionAliases: {},
        version: '1.1',
        isLoaded: true,
    };
    render(
        <CaslAbilityProvider value={ability}>
            <AbilityMetaContext.Provider value={meta}>
                <EmptyState onSuggestion={onSuggestion} />
            </AbilityMetaContext.Provider>
        </CaslAbilityProvider>
    );
    return { onSuggestion };
}

describe('EmptyState suggestion cards', () => {
    it('are inert for a role without create Agent', () => {
        const { onSuggestion } = renderEmptyState(READER);

        const cards = screen.getAllByTestId('empty-state-suggestion') as HTMLButtonElement[];
        expect(cards.length).toBeGreaterThan(0);
        expect(cards.every((c) => c.disabled)).toBe(true);

        cards.forEach((c) => fireEvent.click(c));
        expect(onSuggestion).not.toHaveBeenCalled();
    });

    it('drop the hover affordance and show the not-allowed cursor when denied', () => {
        renderEmptyState(READER);

        const card = screen.getAllByTestId('empty-state-suggestion')[0];
        expect(card.className).toContain('cursor-not-allowed');
        // The hover highlight would advertise a click that cannot happen.
        expect(card.className).not.toContain('hover:border-primary/40');
    });

    it('replaces the composer hint with the denial reason', () => {
        renderEmptyState(READER);

        expect(screen.queryByText(/or just start typing/i)).toBeNull();
        expect(screen.getByText(/do not have permission/i)).toBeTruthy();
    });

    it('stay live for a role that can create — the negative half of the pair', () => {
        const { onSuggestion } = renderEmptyState(WRITER);

        const cards = screen.getAllByTestId('empty-state-suggestion') as HTMLButtonElement[];
        expect(cards.every((c) => c.disabled)).toBe(false);

        fireEvent.click(cards[0]);
        expect(onSuggestion).toHaveBeenCalledTimes(1);
        // The prompt text, not the title, is what fills the composer.
        expect(String(onSuggestion.mock.calls[0][0]).length).toBeGreaterThan(20);
        expect(screen.getByText(/or just start typing/i)).toBeTruthy();
    });
});

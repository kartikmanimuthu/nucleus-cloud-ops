// @vitest-environment jsdom
//
// Declared per-file — see hooks/__tests__/use-can.test.tsx: Vitest 4 removed
// environmentMatchGlobs, so vitest.config.ts's jsdom glob is inert.

/**
 * Shared gating primitives (Gate, GatedButton, GatedDropdownItem).
 *
 * These are what every gated control added across the UI (certificates,
 * skills, deep-agent, knowledge-base, settings, …) is built on, so the
 * contract under test here — disable-with-tooltip by default, hide only on
 * request, row-aware conditions, and a disabled dropdown item that cannot
 * fire — is what backs all of that gating.
 *
 * No jest-dom in this repo's Vitest setup (see other component __tests__
 * dirs), so assertions read raw DOM properties/attributes rather than
 * toBeDisabled()/toBeInTheDocument().
 */

import React from 'react';
import { createMongoAbility } from '@casl/ability';
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppAbility } from '@nucleus/rbac';

import { AbilityProvider as CaslAbilityProvider } from '@casl/react';

import { AbilityMetaContext, type AbilityMeta } from '@/providers/ability-provider';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Gate, GatedButton, GatedDropdownItem } from '../gated';

// jsdom lacks these APIs that Radix's DropdownMenu (Popper + pointer capture)
// relies on when positioning open content — same polyfills as
// agent/workspace/__tests__/composer.test.tsx.
beforeAll(() => {
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {});
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
    if (typeof (globalThis as any).ResizeObserver === 'undefined') {
        (globalThis as any).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
});

function wrapperFor(ability: AppAbility, meta: Partial<AbilityMeta> = {}) {
    const value: AbilityMeta = {
        modules: [],
        actions: [],
        subjects: [],
        // Required on AbilityMeta since the grantable cells began riding
        // along with the ability payload. Empty: these tests are not about the
        // role grid.
        moduleActions: [],
        actionAliases: {},
        version: '1.1',
        isLoaded: true,
        ...meta,
    };
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <CaslAbilityProvider value={ability}>
                <AbilityMetaContext.Provider value={value}>{children}</AbilityMetaContext.Provider>
            </CaslAbilityProvider>
        );
    };
}

describe('GatedButton', () => {
    it('is enabled with no tooltip when the action is allowed', () => {
        const ability = createMongoAbility([{ action: 'delete', subject: 'Certificate' }]) as AppAbility;
        render(
            <GatedButton action="delete" subject="Certificate">
                Delete
            </GatedButton>,
            { wrapper: wrapperFor(ability) }
        );

        const btn = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
        expect(btn.hasAttribute('title')).toBe(false);
    });

    it('disables (not hides) and surfaces the denial reason by default', () => {
        const ability = createMongoAbility([]) as AppAbility;
        render(
            <GatedButton action="delete" subject="Certificate">
                Delete
            </GatedButton>,
            { wrapper: wrapperFor(ability) }
        );

        const btn = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);

        // The reason lives on the WRAPPER, not the button. A disabled button
        // carries `disabled:pointer-events-none`, so it never receives hover and
        // a title on it can never be displayed — the reason was computed and then
        // thrown away. The wrapper does receive hover, so it owns both the
        // tooltip and the not-allowed cursor.
        const wrapper = btn.parentElement as HTMLElement;
        expect(wrapper.getAttribute('title')).toBe('You do not have permission to delete Certificate.');
        expect(wrapper.className).toContain('cursor-not-allowed');
        expect(wrapper.getAttribute('aria-disabled')).toBe('true');
    });

    it('adds no wrapper when the action is allowed', () => {
        // The wrapper exists only to carry a denial affordance; an allowed
        // control must stay exactly the markup the caller wrote, or layouts
        // that rely on direct-child selectors quietly shift.
        const ability = createMongoAbility([
            { action: 'delete', subject: 'Certificate' },
        ]) as AppAbility;
        render(
            <GatedButton action="delete" subject="Certificate">
                Delete
            </GatedButton>,
            { wrapper: wrapperFor(ability) }
        );

        const btn = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
        expect(btn.parentElement?.className ?? '').not.toContain('cursor-not-allowed');
    });

    /**
     * ── THE asChild REGRESSION ──────────────────────────────────────────────
     * `<GatedButton asChild><Link/></GatedButton>` forwards props onto the child
     * via Radix's Slot. An anchor has no `disabled` attribute, so the browser
     * dropped it silently: the control looked and behaved as fully enabled, and
     * the denial only showed up as a 403 from the API. Three provider controls
     * shipped that way.
     *
     * These assertions are deliberately about the ELEMENT TYPE, not just the
     * disabled flag — an `expect(el.disabled).toBe(true)` on an anchor reads
     * `undefined` and would have passed the broken version too.
     */
    describe('asChild', () => {
        it('renders a real disabled button, not a navigable anchor, when denied', () => {
            const ability = createMongoAbility([]) as AppAbility;
            render(
                <GatedButton action="update" subject="AIOps" asChild>
                    <a href="/app/agent-ops/providers/new">New Provider</a>
                </GatedButton>,
                { wrapper: wrapperFor(ability) }
            );

            // No anchor survives, so there is nothing left to click through.
            expect(screen.queryByRole('link')).toBeNull();

            const btn = screen.getByRole('button', { name: 'New Provider' }) as HTMLButtonElement;
            expect(btn.tagName).toBe('BUTTON');
            expect(btn.disabled).toBe(true);
            expect(btn.getAttribute('href')).toBeNull();
        });

        it('keeps the denial affordance on the wrapper', () => {
            const ability = createMongoAbility([]) as AppAbility;
            render(
                <GatedButton action="update" subject="AIOps" asChild>
                    <a href="/x">Edit</a>
                </GatedButton>,
                { wrapper: wrapperFor(ability) }
            );

            const wrapper = screen.getByRole('button', { name: 'Edit' }).parentElement as HTMLElement;
            expect(wrapper.className).toContain('cursor-not-allowed');
            expect(wrapper.getAttribute('title')).toBe('You do not have permission to update AIOps.');
        });

        it('leaves the anchor intact when allowed — asChild still works', () => {
            const ability = createMongoAbility([{ action: 'update', subject: 'AIOps' }]) as AppAbility;
            render(
                <GatedButton action="update" subject="AIOps" asChild>
                    <a href="/app/agent-ops/providers/new">New Provider</a>
                </GatedButton>,
                { wrapper: wrapperFor(ability) }
            );

            const link = screen.getByRole('link', { name: 'New Provider' });
            expect(link.tagName).toBe('A');
            expect(link.getAttribute('href')).toBe('/app/agent-ops/providers/new');
        });
    });

    it('renders nothing when denied and hideWhenDenied is set', () => {
        const ability = createMongoAbility([]) as AppAbility;
        render(
            <GatedButton action="delete" subject="Certificate" hideWhenDenied>
                Delete
            </GatedButton>,
            { wrapper: wrapperFor(ability) }
        );

        expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    });

    it('evaluates a conditional grant against the row passed via `data`', () => {
        // Mirrors the Certificate delete route's scoped check
        // (authorize('delete', 'Certificate', { domain, accountId })) — the
        // registry maps the condition key to `domain`, not `domainName`.
        const ability = createMongoAbility([
            { action: 'delete', subject: 'Certificate', conditions: { domain: 'x.example.com' } },
        ]) as AppAbility;

        const { rerender } = render(
            <GatedButton action="delete" subject="Certificate" data={{ domain: 'x.example.com' }}>
                Delete
            </GatedButton>,
            { wrapper: wrapperFor(ability) }
        );
        expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);

        rerender(
            <GatedButton action="delete" subject="Certificate" data={{ domain: 'other.example.com' }}>
                Delete
            </GatedButton>
        );
        expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('GatedDropdownItem', () => {
    // DropdownMenuItem must be mounted inside a Radix Menu (Root + Content),
    // matching how call sites actually use it (schedules-table.tsx etc.).
    function renderItem(ability: AppAbility, props: Omit<React.ComponentProps<typeof GatedDropdownItem>, 'children'>) {
        return render(
            <DropdownMenu open>
                <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
                <DropdownMenuContent>
                    <GatedDropdownItem {...props}>Delete</GatedDropdownItem>
                </DropdownMenuContent>
            </DropdownMenu>,
            { wrapper: wrapperFor(ability) }
        );
    }

    it('blocks onSelect and onClick when denied, even if a click lands on it', () => {
        const ability = createMongoAbility([]) as AppAbility;
        const onClick = vi.fn();
        const onSelect = vi.fn();

        renderItem(ability, { action: 'delete', subject: 'Skill', onClick, onSelect });

        fireEvent.click(screen.getByText('Delete'));
        expect(onClick).not.toHaveBeenCalled();
    });

    it('wires through onClick unmodified when allowed', () => {
        const ability = createMongoAbility([{ action: 'delete', subject: 'Skill' }]) as AppAbility;
        const onClick = vi.fn();

        renderItem(ability, { action: 'delete', subject: 'Skill', onClick });

        fireEvent.click(screen.getByText('Delete'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});

describe('Gate', () => {
    it('passes {allowed, reason} through to the render prop', () => {
        const ability = createMongoAbility([
            { action: 'update', subject: 'Skill', reason: 'Only skill authors may edit this skill' },
        ]) as AppAbility;

        render(
            <Gate action="update" subject="Skill" data={{ id: 'skill-1' }}>
                {({ allowed, reason }) => (
                    <button disabled={!allowed} title={reason ?? ''}>
                        Toggle
                    </button>
                )}
            </Gate>,
            { wrapper: wrapperFor(ability) }
        );

        // The rule above is unconditional, so it still grants — assert the
        // render prop reflects that rather than a hard-coded expectation.
        const btn = screen.getByRole('button', { name: 'Toggle' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
    });

    it('hides via hideWhenDenied without the caller having to check `allowed`', () => {
        const ability = createMongoAbility([]) as AppAbility;

        render(
            <Gate action="update" subject="Skill" hideWhenDenied>
                {() => <button>Toggle</button>}
            </Gate>,
            { wrapper: wrapperFor(ability) }
        );

        expect(screen.queryByRole('button', { name: 'Toggle' })).toBeNull();
    });
});

// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see components/rbac/__tests__/gated.test.tsx).

/**
 * The two privileged actions in the Memory row menu.
 *
 * Nothing on /app/memory was gated, while both routes behind these items are:
 *   Delete           -> DELETE /api/agent-memories/:id -> delete/Memory
 *                       ('delete' on this subject means PRUNE)
 *   Promote to skill -> SkillFormDialog -> POST /api/skills -> create/Skill
 *
 * They gate on DIFFERENT subjects, so each test grants one and denies the other.
 * A single allowed/denied flag would let one item's gate satisfy the assertion
 * meant for the other, and would not catch the two being wired to one subject.
 *
 * Assertions are behavioural, not just attribute checks: a denied item must not
 * OPEN its dialog. GatedDropdownItem blocks onClick/onSelect itself, and the
 * point here is that the call sites are wired to it at all.
 *
 * No jest-dom in this repo's Vitest setup, so assertions read raw DOM
 * attributes rather than toBeDisabled().
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import type { MemoryRow } from '@/lib/queries/agent-memories';

// jsdom lacks the APIs Radix's DropdownMenu (Popper + pointer capture) needs to
// position open content — same polyfills as components/rbac/__tests__/gated.test.tsx.
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

/** Answers per (action, subject) so the two items can be gated independently. */
let can: (action: string, subject: string) => boolean = () => true;

vi.mock('@/hooks/use-can', () => ({
    useCan: (action: string, subject: string) => can(action, subject),
    useDenialReason: (action: string, subject: string) =>
        can(action, subject) ? null : `Requires ${action} on ${subject}`,
}));

/**
 * kind PROCEDURAL is required: Promote to skill only renders for procedural
 * memories. The rule fields are real ones so buildSkillDraftFromMemory (not
 * mocked) returns a draft rather than the "missing rule fields" error path.
 */
const ROW = {
    id: 'mem-1',
    userId: 'u1',
    namespace: 'ns/agent',
    category: 'operational',
    key: 'always-check-region',
    fact: 'Always confirm the region before stopping an instance.',
    source: null,
    confidence: null,
    value: {
        rule: 'Always confirm the region before stopping an instance.',
        domain: 'ec2',
        trigger: 'stopping an instance',
    },
    kind: 'PROCEDURAL',
    sourceThreadId: 'run-9',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-11-01T00:00:00.000Z',
    supersededById: null,
    supersededAt: null,
} as unknown as MemoryRow;

const deleteMutate = vi.fn();

vi.mock('@/lib/queries/agent-memories', () => ({
    useAgentMemories: () => ({ data: { data: [ROW], total: 1 }, isLoading: false, error: null }),
    useDeleteAgentMemory: () => ({ mutate: deleteMutate, isPending: false }),
    fetchAllAgentMemories: async () => ({ memories: [ROW], total: 1 }),
}));

// Stubbed so the test does not drag in the skills query layer, but still
// observable: this is how "did Promote actually open?" is asserted.
vi.mock('@/components/skills/skill-form-dialog', () => ({
    SkillFormDialog: ({ open }: { open: boolean }) => (open ? <div>skill-form-open</div> : null),
}));

import { MemoryClientComponent } from '../memory-client-component';

/**
 * pointerDown, not click: Radix's DropdownMenuTrigger opens on pointerdown, so a
 * click alone leaves the menu closed and every item lookup below fails.
 */
const openRowMenu = () =>
    fireEvent.pointerDown(screen.getByRole('button', { name: /open actions/i }), {
        button: 0,
        ctrlKey: false,
    });
const item = (name: RegExp) => screen.getByText(name).closest('[role="menuitem"]') as HTMLElement;

describe('Memory row actions are permission-gated', () => {
    beforeEach(() => {
        deleteMutate.mockClear();
    });

    it('disables Delete and blocks its dialog when Memory:delete is denied', () => {
        // Skill:create granted, so a Promote gate cannot be what satisfies this.
        can = (action, subject) => !(action === 'delete' && subject === 'Memory');
        render(<MemoryClientComponent />);
        openRowMenu();

        const del = item(/^Delete$/);
        expect(del.getAttribute('aria-disabled')).toBe('true');
        expect(del.getAttribute('title')).toBe('Requires delete on Memory');

        fireEvent.click(del);
        // The confirmation dialog must not open, so the mutation is unreachable.
        expect(screen.queryByText('Delete this memory?')).toBeNull();
        expect(deleteMutate).not.toHaveBeenCalled();
    });

    it('disables Promote to skill and blocks its dialog when Skill:create is denied', () => {
        // Memory:delete granted, isolating the Promote gate.
        can = (action, subject) => !(action === 'create' && subject === 'Skill');
        render(<MemoryClientComponent />);
        openRowMenu();

        const promote = item(/Promote to skill/);
        expect(promote.getAttribute('aria-disabled')).toBe('true');
        expect(promote.getAttribute('title')).toBe('Requires create on Skill');

        fireEvent.click(promote);
        expect(screen.queryByText('skill-form-open')).toBeNull();
    });

    it('leaves both usable when the respective permissions are granted', () => {
        can = () => true;
        render(<MemoryClientComponent />);
        openRowMenu();

        expect(item(/^Delete$/).getAttribute('aria-disabled')).toBeNull();
        expect(item(/Promote to skill/).getAttribute('aria-disabled')).toBeNull();

        fireEvent.click(item(/^Delete$/));
        expect(screen.getByText('Delete this memory?')).toBeTruthy();
    });

    it('never gates View details, which needs only the read this page already used', () => {
        can = () => false;
        render(<MemoryClientComponent />);
        openRowMenu();

        // GET /api/agent-memories/:id is read/Memory — the same permission that
        // loaded the table. Gating it would disable a control that cannot 403.
        expect(item(/View details/).getAttribute('aria-disabled')).toBeNull();
    });
});

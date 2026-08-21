// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see components/rbac/__tests__/gated.test.tsx).

/**
 * Both save buttons in the AI Ops settings dialog must be gated.
 *
 * AiopsFeatureSettings ("Save behavior settings") and AiopsSubagentSettings
 * ("Save settings") are rendered side by side, and BOTH write through
 * PUT /api/settings/aiops, which enforces authorize('update', 'Agent') —
 * subject 'Agent' being the "AI Agent" submodule under AI Ops. Neither was
 * gated, so a role without that permission got two live buttons and two 403s.
 *
 * One file for both because the shared route is the whole point: gating one and
 * not the other would leave the same denial reachable by a different click.
 *
 * Both directions are asserted. A denied-only test passes just as well against a
 * button hardcoded to disabled, which would break saving for everyone.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';

// Radix Switch measures itself; same polyfill as components/rbac/__tests__/gated.test.tsx.
beforeAll(() => {
    if (typeof (globalThis as any).ResizeObserver === 'undefined') {
        (globalThis as any).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
});

let allowed = true;

vi.mock('@/hooks/use-can', () => ({
    useCan: () => allowed,
    useDenialReason: () => (allowed ? null : 'Requires Update on AI Agent'),
}));

/**
 * Hoisted for a STABLE identity — both components hydrate from this in an effect
 * keyed on `data`, so a fresh object literal per call would re-fire it every
 * render until React's update-depth guard trips.
 *
 * platformEnabled must be true: the sub-agent form disables its own button while
 * the platform is off, which would mask the permission gate under test.
 */
const SETTINGS = {
    platformEnabled: true,
    budget: {
        maxConcurrentSubagents: 3,
        maxSubagentsPerRun: 8,
        tokenBudgetPerRun: 400000,
        maxIterationsPerSubagent: 8,
        subagentTimeoutMs: 180000,
    },
    bounds: undefined,
    features: {
        chatTriageEnabled: true,
        workingMemoryEnabled: true,
        episodicMemoryEnabled: true,
        proceduralMemoryEnabled: true,
        memoryReconcileEnabled: true,
        autoSkillCreationEnabled: true,
        maxIterations: 30,
        autoSkillMaturityThreshold: 3,
        skillSynthesisMinRules: 3,
    },
    featureBounds: undefined,
};

vi.mock('@/lib/queries/aiops-settings', () => ({
    useAiopsSubagentSettings: () => ({ data: SETTINGS, isLoading: false, error: null }),
    useSaveAiopsSubagentSettings: () => ({ mutate: vi.fn(), isPending: false }),
    useSaveAiopsFeatureSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AiopsFeatureSettings } from '../aiops-feature-settings';
import { AiopsSubagentSettings } from '../aiops-subagent-settings';

const behaviorSave = () =>
    screen.getByRole('button', { name: /save behavior settings/i }) as HTMLButtonElement;
const subagentSave = () => screen.getByRole('button', { name: /^save settings$/i }) as HTMLButtonElement;

describe('AI Ops settings — both save buttons gate on Agent:update', () => {
    it('disables both and surfaces the reason when denied', () => {
        allowed = false;
        render(
            <>
                <AiopsFeatureSettings />
                <AiopsSubagentSettings />
            </>
        );

        for (const button of [behaviorSave(), subagentSave()]) {
            expect(button.disabled).toBe(true);
            // The reason sits on the wrapper span — the primitive's
            // disabled:pointer-events-none would swallow a title on the button.
            expect(button.parentElement?.getAttribute('title')).toBe('Requires Update on AI Agent');
        }
    });

    it('leaves both working when granted', () => {
        allowed = true;
        render(
            <>
                <AiopsFeatureSettings />
                <AiopsSubagentSettings />
            </>
        );

        for (const button of [behaviorSave(), subagentSave()]) {
            expect(button.disabled).toBe(false);
            expect(button.parentElement?.getAttribute('title')).toBeNull();
        }
    });
});

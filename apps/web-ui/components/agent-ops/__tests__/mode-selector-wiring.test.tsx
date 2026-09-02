// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see components/rbac/__tests__/gated.test.tsx).

/**
 * Task 11 wiring test.
 *
 * The risk here is silent non-wiring: a mode selector that renders, changes
 * local state, and never reaches the request body. Nobody would notice until
 * a "deep" run quietly executed as plan.
 *
 * Both REAL dialog components are rendered (not local copies of their
 * markup) — a hand-built stand-in would keep passing after the real selector
 * regressed. Only fetch, next/navigation, and RBAC gating are mocked.
 */
import { beforeAll, describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// jsdom lacks these APIs that Radix's Select/Dialog (Popper + pointer capture)
// rely on when opening/positioning their portal content.
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

vi.mock('@/hooks/use-can', () => ({
    useCan: () => true,
    useDenialReason: () => null,
}));

const push = vi.fn();
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push }),
}));

import { NewRunDialog } from '../new-run-dialog';
import { ScheduledTaskDialog } from '../scheduled-task-dialog';
import type { ScheduledTask } from '@/lib/agent-ops/types';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

function selectMode(scope: HTMLElement, label: RegExp, optionLabel: RegExp) {
    fireEvent.click(within(scope).getByRole('combobox', { name: label }));
    fireEvent.click(screen.getByRole('option', { name: optionLabel }));
}

describe('New Run dialog — always deep', () => {
    // The Execution mode picker was removed deliberately: Agent Ops runs on the
    // deep agent, always. These tests pin that contract — the dialog must still
    // SEND the mode explicitly (so the run row records what it executed in),
    // and must offer no way to choose anything else.
    it('sends mode "deep" in the POST body to /api/v1/gateway/api', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true, json: async () => ({ runId: 'r1' }),
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<NewRunDialog tenantId="t1" />);
        fireEvent.click(screen.getByRole('button', { name: /new agent run/i }));
        const dialog = screen.getByRole('dialog');

        fireEvent.change(within(dialog).getByRole('textbox'), {
            target: { value: 'audit s3 buckets' },
        });
        fireEvent.click(within(dialog).getByRole('button', { name: /trigger run/i }));

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [url, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(url).toBe('/api/v1/gateway/api');
        expect(body.mode).toBe('deep');
    });

    it('offers no execution-mode control at all', () => {
        render(<NewRunDialog tenantId="t1" />);
        fireEvent.click(screen.getByRole('button', { name: /new agent run/i }));
        const dialog = screen.getByRole('dialog');

        // No combobox, and no lingering copy from the removed field.
        expect(within(dialog).queryByRole('combobox')).toBeNull();
        expect(within(dialog).queryByText(/execution mode/i)).toBeNull();
        expect(within(dialog).queryByText(/plan & execute/i)).toBeNull();
    });
});

describe('Scheduled task dialog — mode wiring', () => {
    it('sends the selected mode ("deep") in the create-task payload', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ task: { taskId: 'task-1' } }),
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<ScheduledTaskDialog tenantId="t1" open onOpenChange={() => {}} />);

        fireEvent.change(screen.getByPlaceholderText(/daily cost anomaly review/i), {
            target: { value: 'My scheduled task' },
        });
        fireEvent.change(screen.getByPlaceholderText(/what should the agent do on each run/i), {
            target: { value: 'Scan every night' },
        });

        selectMode(document.body, /execution mode/i, /^deep/i);

        fireEvent.click(screen.getByRole('button', { name: /create task/i }));

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/agent-ops/scheduled-tasks');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.mode).toBe('deep');
    });

    it('defaults an existing plan-mode task to "plan" in its form state', () => {
        const task = {
            taskId: 't1',
            tenantId: 't1',
            name: 'Existing',
            description: 'desc',
            scheduleType: 'cron',
            cronExpression: '0 9 * * *',
            timezone: 'UTC',
            taskStatus: 'active',
            mode: 'plan',
            autoApprove: false,
            notification: { type: 'none' },
            runCount: 0,
            createdAt: '',
            updatedAt: '',
            createdBy: 'x',
        } as unknown as ScheduledTask;

        render(<ScheduledTaskDialog tenantId="t1" task={task} open onOpenChange={() => {}} />);
        const combobox = screen.getByRole('combobox', { name: /execution mode/i });
        expect(combobox.textContent).toMatch(/plan/i);
    });

    it('never offers "fast" as an execution mode', () => {
        render(<ScheduledTaskDialog tenantId="t1" open onOpenChange={() => {}} />);

        fireEvent.click(screen.getByRole('combobox', { name: /execution mode/i }));
        const options = screen.getAllByRole('option');

        expect(options).toHaveLength(2);
        expect(options.some(o => /fast/i.test(o.textContent || ''))).toBe(false);
    });
});

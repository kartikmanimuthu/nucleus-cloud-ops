/**
 * Unit tests for slack-notifier.ts
 *
 * Requirements: Async result delivery
 *
 * Covers:
 * - postResultToSlack: successful POST formats message correctly
 * - postResultToSlack: failure is swallowed without throwing
 * - postErrorToSlack: successful POST formats message correctly
 * - postErrorToSlack: failure is swallowed without throwing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postResultToSlack, postErrorToSlack } from '@/lib/agent-ops/slack-notifier';
import type { AgentOpsRun } from '@/lib/agent-ops/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<AgentOpsRun> = {}): AgentOpsRun {
    const runId = 'run-abc-123';
    return {
        PK: 'TENANT#T0001',
        SK: `RUN#${runId}`,
        GSI1PK: 'SOURCE#slack',
        GSI1SK: `2024-01-01T00:00:00.000Z#${runId}`,
        runId,
        tenantId: 'T0001',
        source: 'slack',
        status: 'completed',
        taskDescription: 'Check Lambda configs',
        mode: 'fast',
        threadId: `agent-ops-${runId}`,
        trigger: {
            userId: 'U0001',
            channelId: 'C0001',
            responseUrl: 'https://hooks.slack.com/commands/abc',
        },
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:01.000Z',
        ttl: 1700000000,
        result: {
            summary: 'All Lambda configs look good.',
            toolsUsed: ['list-lambdas'],
            iterations: 2,
        },
        ...overrides,
    } as AgentOpsRun;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => { });
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// postResultToSlack
// ---------------------------------------------------------------------------

describe('postResultToSlack', () => {
    it('calls fetch with the responseUrl', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);

        const run = makeRun();
        await postResultToSlack(run, run.trigger.responseUrl);

        expect(mockFetch).toHaveBeenCalledOnce();
        expect(mockFetch).toHaveBeenCalledWith(
            run.trigger.responseUrl,
            expect.any(Object),
        );

        vi.unstubAllGlobals();
    });

    it('sends response_type: in_channel', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);

        const run = makeRun();
        await postResultToSlack(run, run.trigger.responseUrl);

        const [, init] = mockFetch.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.response_type).toBe('in_channel');

        vi.unstubAllGlobals();
    });

    it('includes ✅ Complete and the result summary in the message text', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);

        const run = makeRun();
        await postResultToSlack(run, run.trigger.responseUrl);

        const [, init] = mockFetch.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.text).toContain('✅ Complete');
        expect(body.text).toContain('All Lambda configs look good.');

        vi.unstubAllGlobals();
    });

    it('uses "(no summary)" when result.summary is absent', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);

        const run = makeRun({ result: undefined });
        await postResultToSlack(run, run.trigger.responseUrl);

        const [, init] = mockFetch.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.text).toContain('(no summary)');

        vi.unstubAllGlobals();
    });

    it('does NOT throw when fetch rejects', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));

        const run = makeRun();
        await expect(postResultToSlack(run, run.trigger.responseUrl)).resolves.toBeUndefined();

        vi.unstubAllGlobals();
    });

    it('logs the error via console.error when fetch rejects', async () => {
        const networkError = new Error('network failure');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

        const run = makeRun();
        await postResultToSlack(run, run.trigger.responseUrl);

        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('[slack-notifier]'),
            networkError,
        );

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// postErrorToSlack
// ---------------------------------------------------------------------------

describe('postErrorToSlack', () => {
    it('calls fetch with the responseUrl', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);

        await postErrorToSlack(new Error('boom'), 'run-abc-123', 'https://hooks.slack.com/commands/abc');

        expect(mockFetch).toHaveBeenCalledOnce();
        expect(mockFetch).toHaveBeenCalledWith(
            'https://hooks.slack.com/commands/abc',
            expect.any(Object),
        );

        vi.unstubAllGlobals();
    });

    it('includes ❌ Agent Ops failed: and the error message in the text', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);

        await postErrorToSlack(new Error('something went wrong'), 'run-abc-123', 'https://hooks.slack.com/commands/abc');

        const [, init] = mockFetch.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.text).toContain('❌ Agent Ops failed:');
        expect(body.text).toContain('something went wrong');

        vi.unstubAllGlobals();
    });

    it('handles non-Error objects by stringifying them', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);

        await postErrorToSlack('plain string error', 'run-abc-123', 'https://hooks.slack.com/commands/abc');

        const [, init] = mockFetch.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.text).toContain('plain string error');

        vi.unstubAllGlobals();
    });

    it('does NOT throw when fetch rejects', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));

        await expect(
            postErrorToSlack(new Error('agent error'), 'run-abc-123', 'https://hooks.slack.com/commands/abc'),
        ).resolves.toBeUndefined();

        vi.unstubAllGlobals();
    });

    it('logs the error via console.error when fetch rejects', async () => {
        const networkError = new Error('network failure');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

        await postErrorToSlack(new Error('agent error'), 'run-abc-123', 'https://hooks.slack.com/commands/abc');

        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('[slack-notifier]'),
            networkError,
        );

        vi.unstubAllGlobals();
    });
});

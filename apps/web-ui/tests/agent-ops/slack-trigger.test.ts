/**
 * Unit tests for the Slack trigger route
 *
 * Requirements: Slack slash command handler
 *
 * Covers:
 * - 401 on invalid signature
 * - 200 with usage hint on empty text
 * - 200 acknowledgement with runId on valid request
 * - executeAgentRun is called without await (fire-and-forget)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock functions so they are available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
    mockVerifySlackSignature,
    mockParseSlackSlashCommand,
    mockCreateRun,
    mockGetRun,
    mockExecuteAgentRun,
    mockPostResultToSlack,
    mockPostErrorToSlack,
} = vi.hoisted(() => ({
    mockVerifySlackSignature: vi.fn(),
    mockParseSlackSlashCommand: vi.fn(),
    mockCreateRun: vi.fn(),
    mockGetRun: vi.fn(),
    mockExecuteAgentRun: vi.fn(),
    mockPostResultToSlack: vi.fn(),
    mockPostErrorToSlack: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/agent-ops/slack-validator', () => ({
    verifySlackSignature: mockVerifySlackSignature,
    parseSlackSlashCommand: mockParseSlackSlashCommand,
}));

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: {
        createRun: mockCreateRun,
        getRun: mockGetRun,
    },
}));

vi.mock('@/lib/agent-ops/agent-executor', () => ({
    executeAgentRun: mockExecuteAgentRun,
}));

vi.mock('@/lib/agent-ops/slack-notifier', () => ({
    postResultToSlack: mockPostResultToSlack,
    postErrorToSlack: mockPostErrorToSlack,
}));

// Import after mocks
import { POST } from '../../app/api/v1/trigger/slack/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: string, headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/api/v1/trigger/slack', {
        method: 'POST',
        body,
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            ...headers,
        },
    });
}

function makeSlackPayload(overrides: Record<string, string> = {}) {
    return {
        token: 'tok123',
        team_id: 'T0001',
        team_domain: 'example',
        channel_id: 'C0001',
        channel_name: 'general',
        user_id: 'U0001',
        user_name: 'alice',
        command: '/cloud-ops',
        text: 'Check Lambda configs',
        response_url: 'https://hooks.slack.com/commands/abc',
        trigger_id: 'trig123',
        ...overrides,
    };
}

function makeRun(runId = 'test-run-123') {
    return {
        PK: 'TENANT#T0001',
        SK: `RUN#${runId}`,
        GSI1PK: 'SOURCE#slack',
        GSI1SK: `2024-01-01T00:00:00.000Z#${runId}`,
        runId,
        tenantId: 'T0001',
        source: 'slack' as const,
        status: 'queued' as const,
        taskDescription: 'Check Lambda configs',
        mode: 'fast' as const,
        threadId: `agent-ops-${runId}`,
        trigger: {
            userId: 'U0001',
            channelId: 'C0001',
            responseUrl: 'https://hooks.slack.com/commands/abc',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();
    // Default: executeAgentRun resolves immediately
    mockExecuteAgentRun.mockResolvedValue(undefined);
    mockPostResultToSlack.mockResolvedValue(undefined);
    mockPostErrorToSlack.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. 401 on invalid signature
// ---------------------------------------------------------------------------

describe('401 on invalid signature', () => {
    it('returns 401 when verifySlackSignature returns false', async () => {
        mockVerifySlackSignature.mockReturnValue(false);

        const req = makeRequest('token=tok&text=hello', {
            'x-slack-request-timestamp': '1234567890',
            'x-slack-signature': 'v0=badsig',
        });

        const res = await POST(req);

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body).toMatchObject({ error: 'Invalid signature' });
    });

    it('does NOT call createRun when signature is invalid', async () => {
        mockVerifySlackSignature.mockReturnValue(false);

        const req = makeRequest('token=tok&text=hello');
        await POST(req);

        expect(mockCreateRun).not.toHaveBeenCalled();
    });

    it('does NOT call executeAgentRun when signature is invalid', async () => {
        mockVerifySlackSignature.mockReturnValue(false);

        const req = makeRequest('token=tok&text=hello');
        await POST(req);

        expect(mockExecuteAgentRun).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 2. 200 with usage hint on empty text
// ---------------------------------------------------------------------------

describe('200 with usage hint on empty text', () => {
    it('returns 200 with usage hint when text is empty', async () => {
        mockVerifySlackSignature.mockReturnValue(true);
        mockParseSlackSlashCommand.mockReturnValue(makeSlackPayload({ text: '' }));

        const req = makeRequest('token=tok&text=');
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.response_type).toBe('ephemeral');
        expect(body.text).toContain('/cloud-ops');
    });

    it('returns 200 with usage hint when text is whitespace only', async () => {
        mockVerifySlackSignature.mockReturnValue(true);
        mockParseSlackSlashCommand.mockReturnValue(makeSlackPayload({ text: '   ' }));

        const req = makeRequest('token=tok&text=+++');
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.response_type).toBe('ephemeral');
        expect(body.text).toContain('/cloud-ops');
    });

    it('does NOT call createRun when text is empty', async () => {
        mockVerifySlackSignature.mockReturnValue(true);
        mockParseSlackSlashCommand.mockReturnValue(makeSlackPayload({ text: '' }));

        const req = makeRequest('token=tok&text=');
        await POST(req);

        expect(mockCreateRun).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 3. 200 acknowledgement with runId on valid request
// ---------------------------------------------------------------------------

describe('200 acknowledgement with runId on valid request', () => {
    it('returns 200 with runId in the response body', async () => {
        const run = makeRun('test-run-123');
        mockVerifySlackSignature.mockReturnValue(true);
        mockParseSlackSlashCommand.mockReturnValue(makeSlackPayload());
        mockCreateRun.mockResolvedValue(run);

        const req = makeRequest('token=tok&text=Check+Lambda+configs');
        const res = await POST(req);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.response_type).toBe('ephemeral');
        expect(body.text).toContain('test-run-123');
    });

    it('calls createRun with source=slack and the task description', async () => {
        const run = makeRun();
        mockVerifySlackSignature.mockReturnValue(true);
        mockParseSlackSlashCommand.mockReturnValue(makeSlackPayload({ text: 'Check Lambda configs' }));
        mockCreateRun.mockResolvedValue(run);

        const req = makeRequest('token=tok&text=Check+Lambda+configs');
        await POST(req);

        expect(mockCreateRun).toHaveBeenCalledWith(
            expect.objectContaining({
                source: 'slack',
                taskDescription: 'Check Lambda configs',
            }),
        );
    });

    it('calls createRun with tenantId from team_id', async () => {
        const run = makeRun();
        mockVerifySlackSignature.mockReturnValue(true);
        mockParseSlackSlashCommand.mockReturnValue(makeSlackPayload({ team_id: 'T9999' }));
        mockCreateRun.mockResolvedValue(run);

        const req = makeRequest('token=tok&text=hello');
        await POST(req);

        expect(mockCreateRun).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'T9999' }),
        );
    });
});

// ---------------------------------------------------------------------------
// 4. Fire-and-forget: executeAgentRun is NOT awaited
// ---------------------------------------------------------------------------

describe('fire-and-forget: executeAgentRun is not awaited', () => {
    it('returns a response before executeAgentRun resolves', async () => {
        const run = makeRun();
        mockVerifySlackSignature.mockReturnValue(true);
        mockParseSlackSlashCommand.mockReturnValue(makeSlackPayload());
        mockCreateRun.mockResolvedValue(run);

        // Never-resolving promise — if the route awaits this, it will hang
        mockExecuteAgentRun.mockReturnValue(new Promise(() => { }));

        const req = makeRequest('token=tok&text=Check+Lambda+configs');

        // Should resolve quickly without waiting for executeAgentRun
        const res = await Promise.race([
            POST(req),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Route timed out — likely awaiting executeAgentRun')), 500),
            ),
        ]);

        expect((res as Response).status).toBe(200);
    });

    it('calls executeAgentRun exactly once with the created run', async () => {
        const run = makeRun('fire-forget-run');
        mockVerifySlackSignature.mockReturnValue(true);
        mockParseSlackSlashCommand.mockReturnValue(makeSlackPayload());
        mockCreateRun.mockResolvedValue(run);
        mockExecuteAgentRun.mockResolvedValue(undefined);

        const req = makeRequest('token=tok&text=Check+Lambda+configs');
        await POST(req);

        expect(mockExecuteAgentRun).toHaveBeenCalledTimes(1);
        expect(mockExecuteAgentRun).toHaveBeenCalledWith(run);
    });

    it('attaches .then() handler that calls postResultToSlack on success', async () => {
        const run = makeRun();
        mockVerifySlackSignature.mockReturnValue(true);
        mockParseSlackSlashCommand.mockReturnValue(makeSlackPayload());
        mockCreateRun.mockResolvedValue(run);

        let resolveExecute!: () => void;
        const executePromise = new Promise<void>((resolve) => { resolveExecute = resolve; });
        mockExecuteAgentRun.mockReturnValue(executePromise);

        const req = makeRequest('token=tok&text=Check+Lambda+configs');
        await POST(req);

        // Resolve the agent run after the route has returned
        resolveExecute();
        await executePromise;
        // Allow microtasks to flush
        await Promise.resolve();

        expect(mockPostResultToSlack).toHaveBeenCalledWith(run, run.trigger.responseUrl);
    });

    it('attaches .catch() handler that calls postErrorToSlack on failure', async () => {
        const run = makeRun();
        mockVerifySlackSignature.mockReturnValue(true);
        mockParseSlackSlashCommand.mockReturnValue(makeSlackPayload());
        mockCreateRun.mockResolvedValue(run);

        const agentError = new Error('Agent exploded');
        mockExecuteAgentRun.mockRejectedValue(agentError);

        const req = makeRequest('token=tok&text=Check+Lambda+configs');
        await POST(req);

        // Allow microtasks to flush
        await Promise.resolve();
        await Promise.resolve();

        expect(mockPostErrorToSlack).toHaveBeenCalledWith(agentError, run.runId, run.trigger.responseUrl);
    });
});

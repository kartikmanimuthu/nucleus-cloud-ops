/**
 * Unit tests for the legacy Slack trigger route.
 *
 * /api/v1/trigger/slack is now a backward-compat redirect (kept only because
 * some Slack app configs may still point at it) — the slash-command handling
 * this file used to test directly (signature verification, run creation,
 * fire-and-forget executeAgentRun, Slack ack/notification) all moved into the
 * generic gateway pipeline:
 *   - GatewayService.handleInbound()  → tests/gateway/gateway-service.test.ts
 *   - SlackAdapter                    → tests/gateway/adapters/slack-adapter.test.ts
 * This route's only remaining job is to delegate to that pipeline with the
 * right channel type, which is what this file verifies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHandleInbound, mockGetGatewayService } = vi.hoisted(() => {
    const mockHandleInbound = vi.fn();
    return {
        mockHandleInbound,
        mockGetGatewayService: vi.fn(() => ({ handleInbound: mockHandleInbound })),
    };
});

vi.mock('@/lib/gateway', () => ({
    getGatewayService: mockGetGatewayService,
}));

import { POST } from '../../app/api/v1/trigger/slack/route';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('POST /api/v1/trigger/slack (legacy redirect)', () => {
    it('delegates to GatewayService.handleInbound with channelType "slack"', async () => {
        const expectedResponse = new Response(JSON.stringify({ response_type: 'ephemeral' }), { status: 200 });
        mockHandleInbound.mockResolvedValue(expectedResponse);

        const req = new Request('http://localhost/api/v1/trigger/slack', {
            method: 'POST',
            body: 'token=tok&text=hello',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });

        const res = await POST(req as any);

        expect(mockGetGatewayService).toHaveBeenCalledOnce();
        expect(mockHandleInbound).toHaveBeenCalledWith('slack', req);
        expect(res).toBe(expectedResponse);
    });

    it('returns whatever GatewayService.handleInbound returns, including error responses', async () => {
        const errorResponse = new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
        mockHandleInbound.mockResolvedValue(errorResponse);

        const req = new Request('http://localhost/api/v1/trigger/slack', {
            method: 'POST',
            body: 'token=tok&text=hello',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });

        const res = await POST(req as any);

        expect(res.status).toBe(401);
    });
});

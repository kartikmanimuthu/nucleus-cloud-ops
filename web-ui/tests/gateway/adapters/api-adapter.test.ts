import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiAdapter } from '@/lib/gateway/adapters/api-adapter';

describe('ApiAdapter', () => {
    let adapter: ApiAdapter;

    beforeEach(() => {
        adapter = new ApiAdapter();
    });

    it('has correct channel metadata', () => {
        expect(adapter.channelType).toBe('api');
        expect(adapter.deliveryMode).toBe('polling');
        expect(adapter.hilCapabilities).toEqual({
            clarification: false,
            approvalButtons: false,
            threadedReplies: false,
        });
    });

    it('validates bearer token auth', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'authorization': 'Bearer test-token', 'content-type': 'application/json' },
            body: JSON.stringify({ taskDescription: 'test' }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(true);
    });

    it('validates API key auth', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'x-api-key': 'key-123', 'content-type': 'application/json' },
            body: JSON.stringify({ taskDescription: 'test' }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(true);
    });

    it('rejects requests with no auth', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ taskDescription: 'test' }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(false);
    });

    it('parseInbound extracts task description and options', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-1' },
            body: JSON.stringify({ taskDescription: 'Check Lambda configs', mode: 'plan', autoApprove: true }),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('api');
        expect(msg.taskDescription).toBe('Check Lambda configs');
        expect(msg.tenantId).toBe('tenant-1');
        expect(msg.mode).toBe('plan');
        expect(msg.autoApprove).toBe(true);
    });

    it('sendAck returns runId and queued status', async () => {
        const req = new Request('http://localhost', { method: 'POST' });
        const res = await adapter.sendAck(req as any, 'run-1');
        const json = await res.json();
        expect(json.runId).toBe('run-1');
        expect(json.status).toBe('queued');
    });
});

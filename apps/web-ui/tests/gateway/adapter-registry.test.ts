// web-ui/tests/gateway/adapter-registry.test.ts
import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from '@/lib/gateway/adapter-registry';
import type { ChannelAdapter } from '@/lib/gateway/types';

function makeMockAdapter(channelType: string): ChannelAdapter {
    return {
        channelType: channelType as any,
        deliveryMode: 'callback',
        hilCapabilities: { clarification: false, approvalButtons: false, threadedReplies: false },
        validateRequest: async () => true,
        parseInbound: async () => ({ channelType: channelType as any, tenantId: 't', taskDescription: 'd', channelMeta: {} }),
        sendAck: async () => new Response(null, { status: 200 }),
        sendResult: async () => {},
        sendError: async () => {},
        sendClarification: async () => {},
        sendApprovalRequest: async () => {},
        getConfig: async () => ({}),
    };
}

describe('AdapterRegistry', () => {
    it('registers and retrieves an adapter', () => {
        const registry = new AdapterRegistry();
        const adapter = makeMockAdapter('slack');
        registry.register(adapter);
        expect(registry.get('slack')).toBe(adapter);
    });

    it('throws on unknown channel type', () => {
        const registry = new AdapterRegistry();
        expect(() => registry.get('slack')).toThrow('No adapter registered for channel: slack');
    });

    it('has() returns correct boolean', () => {
        const registry = new AdapterRegistry();
        expect(registry.has('slack')).toBe(false);
        registry.register(makeMockAdapter('slack'));
        expect(registry.has('slack')).toBe(true);
    });

    it('list() returns all registered channel types', () => {
        const registry = new AdapterRegistry();
        registry.register(makeMockAdapter('slack'));
        registry.register(makeMockAdapter('jira'));
        expect(registry.list()).toEqual(['slack', 'jira']);
    });
});

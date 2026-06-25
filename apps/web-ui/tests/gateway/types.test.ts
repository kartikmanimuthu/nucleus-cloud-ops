// web-ui/tests/gateway/types.test.ts
import { describe, it, expect } from 'vitest';
import type {
    ChannelType, DeliveryMode, GatewayMessage, ReplyContext,
    GatewayEventType, GatewayEvent, ChannelAdapter, HilCapabilities,
} from '@/lib/gateway/types';

describe('Gateway Types', () => {
    it('GatewayMessage accepts all channel types', () => {
        const channels: ChannelType[] = ['slack', 'jira', 'discord', 'telegram', 'webhook', 'api'];
        for (const ch of channels) {
            const msg: GatewayMessage = {
                channelType: ch,
                tenantId: 'tenant-1',
                taskDescription: 'test task',
                channelMeta: {},
            };
            expect(msg.channelType).toBe(ch);
        }
    });

    it('ReplyContext supports all actions', () => {
        const actions: ReplyContext['action'][] = ['clarification_response', 'approve', 'reject'];
        for (const action of actions) {
            const ctx: ReplyContext = { runId: 'run-1', action };
            expect(ctx.action).toBe(action);
        }
    });

    it('GatewayEvent supports all event types', () => {
        const types: GatewayEventType[] = [
            'run:started', 'run:event', 'run:completed', 'run:failed',
            'run:cancelled', 'hil:clarification', 'hil:plan_approval', 'hil:tool_approval',
        ];
        for (const type of types) {
            const event: GatewayEvent = {
                type, runId: 'run-1', tenantId: 'tenant-1',
                timestamp: new Date(), data: {},
            };
            expect(event.type).toBe(type);
        }
    });
});

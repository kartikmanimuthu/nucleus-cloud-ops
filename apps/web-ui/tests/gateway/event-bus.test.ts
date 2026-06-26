// web-ui/tests/gateway/event-bus.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayEventBus } from '@/lib/gateway/event-bus';
import type { GatewayEvent } from '@/lib/gateway/types';

function makeEvent(runId: string, type: GatewayEvent['type'] = 'run:event'): GatewayEvent {
    return { type, runId, tenantId: 'tenant-1', timestamp: new Date(), data: {} };
}

describe('GatewayEventBus', () => {
    let bus: GatewayEventBus;

    beforeEach(() => {
        bus = new GatewayEventBus();
    });

    it('delivers events to subscribers for matching runId', () => {
        const handler = vi.fn();
        bus.subscribe('run-1', handler);
        bus.emit(makeEvent('run-1'));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not deliver events for non-matching runId', () => {
        const handler = vi.fn();
        bus.subscribe('run-1', handler);
        bus.emit(makeEvent('run-2'));
        expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribe stops delivery', () => {
        const handler = vi.fn();
        const unsub = bus.subscribe('run-1', handler);
        unsub();
        bus.emit(makeEvent('run-1'));
        expect(handler).not.toHaveBeenCalled();
    });

    it('cleanup removes all listeners for a runId', () => {
        const h1 = vi.fn();
        const h2 = vi.fn();
        bus.subscribe('run-1', h1);
        bus.subscribe('run-1', h2);
        bus.cleanup('run-1');
        bus.emit(makeEvent('run-1'));
        expect(h1).not.toHaveBeenCalled();
        expect(h2).not.toHaveBeenCalled();
    });

    it('subscribeOnce fires only once for matching type', () => {
        const handler = vi.fn();
        bus.subscribeOnce('run-1', 'run:completed', handler);
        bus.emit(makeEvent('run-1', 'run:event'));
        expect(handler).not.toHaveBeenCalled();
        bus.emit(makeEvent('run-1', 'run:completed'));
        expect(handler).toHaveBeenCalledTimes(1);
        bus.emit(makeEvent('run-1', 'run:completed'));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('supports multiple subscribers for same runId', () => {
        const h1 = vi.fn();
        const h2 = vi.fn();
        bus.subscribe('run-1', h1);
        bus.subscribe('run-1', h2);
        bus.emit(makeEvent('run-1'));
        expect(h1).toHaveBeenCalledTimes(1);
        expect(h2).toHaveBeenCalledTimes(1);
    });
});

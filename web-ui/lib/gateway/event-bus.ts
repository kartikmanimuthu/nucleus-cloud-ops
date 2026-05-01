// web-ui/lib/gateway/event-bus.ts
import { EventEmitter } from 'events';
import type { GatewayEvent, GatewayEventType } from './types';

export class GatewayEventBus {
    private emitter = new EventEmitter();

    constructor() {
        this.emitter.setMaxListeners(100);
    }

    emit(event: GatewayEvent): void {
        this.emitter.emit(`run:${event.runId}`, event);
    }

    subscribe(runId: string, handler: (event: GatewayEvent) => void): () => void {
        const key = `run:${runId}`;
        this.emitter.on(key, handler);
        return () => { this.emitter.removeListener(key, handler); };
    }

    subscribeOnce(runId: string, type: GatewayEventType, handler: (event: GatewayEvent) => void): void {
        const key = `run:${runId}`;
        const wrapper = (event: GatewayEvent) => {
            if (event.type === type) {
                this.emitter.removeListener(key, wrapper);
                handler(event);
            }
        };
        this.emitter.on(key, wrapper);
    }

    cleanup(runId: string): void {
        this.emitter.removeAllListeners(`run:${runId}`);
    }
}

const g = globalThis as typeof globalThis & { _gatewayEventBus?: GatewayEventBus };

export function getGatewayEventBus(): GatewayEventBus {
    if (!g._gatewayEventBus) {
        g._gatewayEventBus = new GatewayEventBus();
    }
    return g._gatewayEventBus;
}

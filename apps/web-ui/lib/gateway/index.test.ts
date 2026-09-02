import { describe, it, expect, beforeEach } from 'vitest';
import * as gatewayIndex from './index';
import { GatewayService } from './gateway-service';
import { AdapterRegistry } from './adapter-registry';

const { getAdapterRegistry, getGatewayService } = gatewayIndex;

// Singletons are cached on globalThis (hot-reload-safe) — clear them so each
// test observes a fresh construction rather than a previous test's instance.
function resetSingletons() {
    const g = globalThis as any;
    delete g._adapterRegistry;
    delete g._gatewayService;
}

describe('gateway/index singletons', () => {
    beforeEach(() => resetSingletons());

    it('getAdapterRegistry registers all six built-in channel adapters', () => {
        const registry = getAdapterRegistry();
        expect(registry).toBeInstanceOf(AdapterRegistry);
        expect(registry.list().sort()).toEqual(['api', 'discord', 'jira', 'slack', 'telegram', 'webhook'].sort());
    });

    it('getAdapterRegistry returns the same instance on repeated calls', () => {
        expect(getAdapterRegistry()).toBe(getAdapterRegistry());
    });

    it('getGatewayService builds a GatewayService wired to the shared adapter registry', () => {
        const service = getGatewayService();
        expect(service).toBeInstanceOf(GatewayService);
        // Building the service must not create a second, disconnected registry.
        expect(getAdapterRegistry().list().length).toBeGreaterThan(0);
    });

    it('getGatewayService returns the same instance on repeated calls', () => {
        expect(getGatewayService()).toBe(getGatewayService());
    });

    it('re-exports GatewayService, GatewayEventBus, AdapterRegistry, and NotificationRouter', () => {
        expect(gatewayIndex.GatewayService).toBeDefined();
        expect(gatewayIndex.GatewayEventBus).toBeDefined();
        expect(gatewayIndex.AdapterRegistry).toBeDefined();
        expect(gatewayIndex.NotificationRouter).toBeDefined();
        expect(gatewayIndex.getGatewayEventBus).toBeDefined();
    });
});

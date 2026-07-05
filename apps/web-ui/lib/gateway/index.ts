// web-ui/lib/gateway/index.ts
import { AdapterRegistry } from './adapter-registry';
import { getGatewayEventBus } from './event-bus';
import { NotificationRouter } from './notification-router';
import { GatewayService } from './gateway-service';
import { SlackAdapter } from './adapters/slack-adapter';
import { JiraAdapter } from './adapters/jira-adapter';
import { DiscordAdapter } from './adapters/discord-adapter';
import { TelegramAdapter } from './adapters/telegram-adapter';
import { WebhookAdapter } from './adapters/webhook-adapter';
import { ApiAdapter } from './adapters/api-adapter';

const g = globalThis as typeof globalThis & {
    _gatewayService?: GatewayService;
    _adapterRegistry?: AdapterRegistry;
};

/** Singleton adapter registry — usable without the full gateway service (e.g. scheduled-run delivery). */
export function getAdapterRegistry(): AdapterRegistry {
    if (!g._adapterRegistry) {
        const registry = new AdapterRegistry();
        registry.register(new SlackAdapter());
        registry.register(new JiraAdapter());
        registry.register(new DiscordAdapter());
        registry.register(new TelegramAdapter());
        registry.register(new WebhookAdapter());
        registry.register(new ApiAdapter());
        g._adapterRegistry = registry;
    }
    return g._adapterRegistry;
}

function createGatewayService(): GatewayService {
    const registry = getAdapterRegistry();
    const eventBus = getGatewayEventBus();
    const router = new NotificationRouter(eventBus, registry);

    return new GatewayService(registry, eventBus, router);
}

export function getGatewayService(): GatewayService {
    if (!g._gatewayService) {
        g._gatewayService = createGatewayService();
    }
    return g._gatewayService;
}

export { GatewayService } from './gateway-service';
export { GatewayEventBus, getGatewayEventBus } from './event-bus';
export { AdapterRegistry } from './adapter-registry';
export { NotificationRouter } from './notification-router';
export type { ChannelType, ChannelAdapter, GatewayMessage, GatewayEvent, ReplyContext, ScheduledOutcome } from './types';

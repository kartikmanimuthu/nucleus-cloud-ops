// web-ui/lib/gateway/adapter-registry.ts
import type { ChannelType, ChannelAdapter } from './types';

export class AdapterRegistry {
    private adapters = new Map<ChannelType, ChannelAdapter>();

    register(adapter: ChannelAdapter): void {
        this.adapters.set(adapter.channelType, adapter);
    }

    get(channelType: ChannelType): ChannelAdapter {
        const adapter = this.adapters.get(channelType);
        if (!adapter) throw new Error(`No adapter registered for channel: ${channelType}`);
        return adapter;
    }

    has(channelType: ChannelType): boolean {
        return this.adapters.has(channelType);
    }

    list(): ChannelType[] {
        return Array.from(this.adapters.keys());
    }
}

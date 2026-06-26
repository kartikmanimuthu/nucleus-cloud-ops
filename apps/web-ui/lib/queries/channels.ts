'use client';

/**
 * TanStack Query hook for the Channels overview page — loads connection status
 * for all integration channels in parallel. Fetches are inlined (no client
 * service class). Each endpoint failure degrades to null for that channel.
 */
import { useQuery } from '@tanstack/react-query';

export interface ChannelStatus {
    slack: { configured: boolean; enabled: boolean } | null;
    jira: { configured: boolean; enabled: boolean } | null;
    discord: { configured: boolean; enabled: boolean } | null;
    telegram: { configured: boolean; enabled: boolean } | null;
    webhook: { configured: boolean; enabled: boolean } | null;
    mcp: { serverCount: number } | null;
    providers: { count: number } | null;
}

const EMPTY_STATUS: ChannelStatus = {
    slack: null,
    jira: null,
    discord: null,
    telegram: null,
    webhook: null,
    mcp: null,
    providers: null,
};

const toToggle = (v: any) =>
    v ? { configured: v.configured ?? false, enabled: v.enabled ?? false } : null;

export function useChannelStatus() {
    return useQuery({
        queryKey: ['channels', 'status'] as const,
        queryFn: async (): Promise<ChannelStatus> => {
            const [slack, jira, discord, telegram, webhook, mcp, providers] =
                await Promise.all([
                    fetch('/api/agent-ops/settings/slack').then((r) => r.json()).catch(() => null),
                    fetch('/api/agent-ops/settings/jira').then((r) => r.json()).catch(() => null),
                    fetch('/api/agent-ops/settings/discord').then((r) => r.json()).catch(() => null),
                    fetch('/api/agent-ops/settings/telegram').then((r) => r.json()).catch(() => null),
                    fetch('/api/agent-ops/settings/webhook').then((r) => r.json()).catch(() => null),
                    fetch('/api/agent-ops/mcp-settings').then((r) => r.json()).catch(() => null),
                    fetch('/api/settings/providers').then((r) => r.json()).catch(() => null),
                ]);

            return {
                slack: toToggle(slack),
                jira: toToggle(jira),
                discord: toToggle(discord),
                telegram: toToggle(telegram),
                webhook: toToggle(webhook),
                mcp: mcp?.servers ? { serverCount: Object.keys(mcp.servers).length } : null,
                providers: providers?.success
                    ? { count: providers.data?.providers?.length ?? 0 }
                    : null,
            };
        },
        placeholderData: (prev) => prev ?? EMPTY_STATUS,
    });
}

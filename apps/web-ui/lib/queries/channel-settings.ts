'use client';

/**
 * Shared TanStack Query hooks for per-channel integration settings
 * (slack/jira/discord/telegram/webhook). The GET shape is uniform
 * ({ configured, enabled }); save bodies differ per channel so the mutation
 * takes an arbitrary body. Both invalidate the channels overview status too.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface ChannelSettings {
    configured: boolean;
    enabled: boolean;
    // Channels expose extra non-secret fields (e.g. jira baseUrl/userEmail);
    // the raw payload is preserved so each form can read what it needs.
    [key: string]: unknown;
}

export function useChannelSettings(channel: string) {
    return useQuery({
        queryKey: ['channel-settings', channel] as const,
        queryFn: async (): Promise<ChannelSettings> => {
            const res = await fetch(`/api/agent-ops/settings/${channel}`);
            const data = await res.json().catch(() => ({}));
            return { ...data, configured: data.configured ?? false, enabled: data.enabled ?? true };
        },
    });
}

/**
 * Imperative fetch of a channel's *plaintext* secrets, used when the user clicks
 * the eye toggle to reveal a stored value. Kept out of the default useChannelSettings
 * query on purpose — secrets are only pulled from the server on explicit reveal,
 * never on page load.
 */
export async function revealChannelSecrets(channel: string): Promise<Record<string, unknown>> {
    const res = await fetch(`/api/agent-ops/settings/${channel}?reveal=1`);
    return res.json().catch(() => ({}));
}

export function useSaveChannelSettings(channel: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: Record<string, unknown>) => {
            const res = await fetch(`/api/agent-ops/settings/${channel}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to save');
            return data;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['channel-settings', channel] });
            qc.invalidateQueries({ queryKey: ['channels', 'status'] });
        },
    });
}

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

/**
 * Reset a channel: deletes its stored configuration so it returns to the
 * unconfigured state. Destructive — the secrets are not recoverable from the UI
 * afterwards — so call sites must confirm first (see ChannelResetCard).
 */
export function useResetChannelSettings(channel: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const res = await fetch(`/api/agent-ops/settings/${channel}`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to reset channel');
            return data;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['channel-settings', channel] });
            qc.invalidateQueries({ queryKey: ['channels', 'status'] });
        },
    });
}

/**
 * Activate/deactivate a configured channel without touching its credentials.
 * Safe because every settings PUT merges the body over the stored config, so
 * an `{ enabled }`-only body keeps all existing secrets. Only call this for
 * channels that are already configured (otherwise the PUT 400s on the
 * required-credential check).
 */
export function useToggleChannelEnabled() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({ channel, enabled }: { channel: string; enabled: boolean }) => {
            const res = await fetch(`/api/agent-ops/settings/${channel}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Failed to ${enabled ? 'activate' : 'deactivate'} channel`);
            return data;
        },
        onSuccess: (_data, { channel }) => {
            qc.invalidateQueries({ queryKey: ['channel-settings', channel] });
            qc.invalidateQueries({ queryKey: ['channels', 'status'] });
        },
    });
}

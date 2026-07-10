'use client';

/**
 * TanStack Query hooks for OAuth connectors — per-tenant app credentials
 * (client id/secret) and OAuth connections (list/disconnect). Secrets are
 * never returned by the API; only masked hints + status.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';

export interface ConnectorApp {
    configured: boolean;
    connectReady: boolean;
    appSource: 'tenant' | 'platform' | 'none';
    platformAvailable: boolean;
    status: string;
    clientId: string;
    clientSecretHint: string | null;
    signingSecretConfigured: boolean;
    botConfigured: boolean;
    botAccountLabel: string | null;
    callbackUrl: string;
    slackInstallCallbackUrl?: string;
}

export interface Connection {
    id: string;
    accountLabel: string;
    scopes: string[];
    status: string;
    tokenType: string;
    expiresAt: string | null;
    createdAt: string;
}

export function useConnectorApp(provider: string) {
    return useQuery({
        queryKey: queryKeys.connectors.app(provider),
        queryFn: async (): Promise<ConnectorApp> => {
            const res = await fetch(`/api/connections/${provider}/app`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load app credentials');
            return data;
        },
    });
}

export function useSaveConnectorApp(provider: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: { clientId: string; clientSecret?: string; signingSecret?: string }) => {
            const res = await fetch(`/api/connections/${provider}/app`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to save');
            return data;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connectors.app(provider) }),
    });
}

export function useDeleteConnectorApp(provider: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const res = await fetch(`/api/connections/${provider}/app`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to remove');
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connectors.app(provider) }),
    });
}

export function useConnections(provider: string) {
    return useQuery({
        queryKey: queryKeys.connectors.connections(provider),
        queryFn: async (): Promise<Connection[]> => {
            const res = await fetch(`/api/connections/${provider}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load connections');
            return data.connections ?? [];
        },
    });
}

export function useDeleteConnection(provider: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/connections/${provider}/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to disconnect');
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.connectors.connections(provider) }),
    });
}

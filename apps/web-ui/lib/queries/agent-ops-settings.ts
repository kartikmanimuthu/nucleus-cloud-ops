'use client';

/**
 * TanStack Query hooks for the Agent Ops default execution config
 * (default model + graph iteration limit), stored per-tenant.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentMode } from '@/lib/agent-ops/types';

// Client-safe copy — agent-ops-defaults.ts pulls in TenantConfigService (server
// only) so its value can't be imported here. Keep in sync with
// lib/agent-ops/agent-ops-defaults.ts's FALLBACK_DEFAULT_MODE.
const FALLBACK_DEFAULT_MODE: AgentMode = 'plan';

export interface AgentOpsDefaults {
    configured: boolean;
    defaultModel: string;
    maxIterations: number;
    defaultMode: AgentMode;
}

const key = ['agent-ops', 'defaults'] as const;

export function useAgentOpsDefaults() {
    return useQuery({
        queryKey: key,
        queryFn: async (): Promise<AgentOpsDefaults> => {
            const res = await fetch('/api/agent-ops/settings/defaults');
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to load Agent Ops defaults');
            return {
                configured: data.configured ?? false,
                defaultModel: data.defaultModel ?? '',
                maxIterations: data.maxIterations ?? 150,
                defaultMode: data.defaultMode ?? FALLBACK_DEFAULT_MODE,
            };
        },
    });
}

export function useSaveAgentOpsDefaults() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: { defaultModel: string; maxIterations: number; defaultMode?: AgentMode }) => {
            const res = await fetch('/api/agent-ops/settings/defaults', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to save Agent Ops defaults');
            return data as AgentOpsDefaults;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    });
}

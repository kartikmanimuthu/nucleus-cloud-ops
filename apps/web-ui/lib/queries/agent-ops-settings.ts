'use client';

/**
 * TanStack Query hooks for the Agent Ops default execution config
 * (default model + graph iteration limit), stored per-tenant.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface AgentOpsDefaults {
    configured: boolean;
    defaultModel: string;
    maxIterations: number;
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
            };
        },
    });
}

export function useSaveAgentOpsDefaults() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: { defaultModel: string; maxIterations: number }) => {
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

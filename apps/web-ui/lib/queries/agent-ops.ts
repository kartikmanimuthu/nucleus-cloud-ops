import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys } from './query-keys';
import type { AgentOpsRun, AgentOpsEvent } from '@/lib/agent-ops/types';

export interface RunListFilters {
    source?: string;
    status?: string;
    limit?: number;
}

export interface RunDetail {
    run: AgentOpsRun;
    events: AgentOpsEvent[];
}

const ACTIVE = new Set(['queued', 'in_progress', 'awaiting_input', 'awaiting_approval']);

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data as T;
}

export function useAgentOpsRuns(filters: RunListFilters = {}) {
    return useQuery({
        queryKey: queryKeys.agentOps.list(filters),
        queryFn: async () => {
            const params = new URLSearchParams({ limit: String(filters.limit ?? 50) });
            if (filters.source && filters.source !== 'all') params.set('source', filters.source);
            if (filters.status && filters.status !== 'all') params.set('status', filters.status);
            const data = await fetchJson<{ runs: AgentOpsRun[] }>(`/api/agent-ops?${params}`);
            return data.runs ?? [];
        },
        refetchInterval: (query) =>
            (query.state.data ?? []).some(r => ACTIVE.has(r.status)) ? 5000 : 30000,
    });
}

export function useAgentOpsRunDetail(runId: string, opts: { pollMs?: number | false } = {}) {
    return useQuery({
        queryKey: queryKeys.agentOps.detail(runId),
        queryFn: () => fetchJson<RunDetail>(`/api/agent-ops/${runId}`),
        enabled: !!runId,
        refetchInterval: opts.pollMs ?? false,
    });
}

function useRunAction(path: (runId: string) => string, verb: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({ runId, body }: { runId: string; body?: Record<string, unknown> }) =>
            fetchJson(path(runId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            }),
        onSuccess: (_d, { runId }) => {
            qc.invalidateQueries({ queryKey: queryKeys.agentOps.detail(runId) });
            qc.invalidateQueries({ queryKey: queryKeys.agentOps.lists() });
        },
        onError: (err) => toast.error(`Failed to ${verb} run`, { description: (err as Error).message }),
    });
}

export function useCancelRun() {
    return useRunAction((id) => `/api/agent-ops/${id}/cancel`, 'cancel');
}
export function useApproveRun() {
    return useRunAction((id) => `/api/agent-ops/${id}/approve`, 'update');
}
export function useResumeRun() {
    return useRunAction((id) => `/api/agent-ops/${id}/resume`, 'resume');
}

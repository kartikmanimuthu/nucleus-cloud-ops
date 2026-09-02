import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys } from './query-keys';
import type { AgentOpsRun, AgentOpsEvent, RunListQuery, RunListStats } from '@/lib/agent-ops/types';

export interface RunListFilters {
    source?: string;
    status?: string;
    page?: number;
    limit?: number;
    sortBy?: RunListQuery['sortBy'];
    sortDir?: 'asc' | 'desc';
}

export interface RunListResponse {
    runs: AgentOpsRun[];
    total: number;
    stats: RunListStats;
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
            const params = new URLSearchParams();
            params.set('page', String(filters.page ?? 1));
            params.set('limit', String(filters.limit ?? 25));
            if (filters.source && filters.source !== 'all') params.set('source', filters.source);
            if (filters.status && filters.status !== 'all') params.set('status', filters.status);
            if (filters.sortBy) {
                params.set('sortBy', filters.sortBy);
                params.set('sortDir', filters.sortDir ?? 'desc');
            }
            const data = await fetchJson<{ success: boolean; data?: AgentOpsRun[]; total?: number; stats?: RunListStats; error?: string }>(`/api/agent-ops?${params}`);
            if (!data.success) throw new Error(data.error || 'Failed to load runs');
            return {
                runs: data.data ?? [],
                total: data.total ?? 0,
                stats: data.stats ?? { total: 0, inProgress: 0, completed: 0, failed: 0 },
            };
        },
        refetchInterval: (query) =>
            (query.state.data?.runs ?? []).some(r => ACTIVE.has(r.status)) ? 5000 : 30000,
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

/**
 * Deep mode per-action decisions — POST /api/agent-ops/[runId]/decisions.
 *
 * Unlike useApproveRun/useResumeRun (binary run-level actions), a deep run
 * can pause with several pending actions at once, so the caller supplies one
 * decision per pending action. The route rejects a partial set (toResumeMap),
 * so the caller (DeepApprovalCard) is responsible for gating submission until
 * every pending action has a decision — this hook only sends what it's given.
 *
 * Success/failure feedback is left to the caller's mutate() options rather
 * than toasted here, since the card shows an outcome-specific message.
 */
export function useSubmitDecisions() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({ runId, decisions }: {
            runId: string;
            decisions: Array<{ toolCallId: string; approved: boolean; reason?: string; answer?: string }>;
        }) =>
            fetchJson<{ success: boolean; data?: { runId: string; status: string; message: string }; error?: string }>(
                `/api/agent-ops/${runId}/decisions`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ decisions }),
                },
            ),
        onSuccess: (_d, { runId }) => {
            qc.invalidateQueries({ queryKey: queryKeys.agentOps.detail(runId) });
            qc.invalidateQueries({ queryKey: queryKeys.agentOps.lists() });
        },
    });
}

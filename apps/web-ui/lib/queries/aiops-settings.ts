'use client';

/**
 * TanStack Query hooks for the AI Ops sub-agent budget (per-tenant).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';

export interface SubagentBudget {
    enabled: boolean;
    maxConcurrentSubagents: number;
    maxSubagentsPerRun: number;
    maxSubagentTokensPerRun: number;
    subagentMaxIterations: number;
    subagentTimeoutMs: number;
}

export interface SubagentBound { min: number; max: number; default: number }

export interface AiopsFeatureConfig {
    chatTriageEnabled: boolean;
    workingMemoryEnabled: boolean;
    episodicMemoryEnabled: boolean;
    proceduralMemoryEnabled: boolean;
    memoryReconcileEnabled: boolean;
    autoSkillCreationEnabled: boolean;
    autoSkillMaturityThreshold: number;
    skillSynthesisMinRules: number;
    maxIterations: number;
}

export interface AiopsSubagentSettings {
    budget: SubagentBudget;
    bounds: Record<keyof Omit<SubagentBudget, 'enabled'>, SubagentBound>;
    /** False when SUBAGENTS_ENABLED is off for the whole deployment. */
    platformEnabled: boolean;
    features: AiopsFeatureConfig;
    featureBounds: Record<'autoSkillMaturityThreshold' | 'skillSynthesisMinRules' | 'maxIterations', SubagentBound>;
}

export function useAiopsSubagentSettings() {
    return useQuery({
        queryKey: queryKeys.aiopsSettings.subagents(),
        queryFn: async (): Promise<AiopsSubagentSettings> => {
            const res = await fetch('/api/settings/aiops');
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load AI Ops settings');
            }
            return json.data as AiopsSubagentSettings;
        },
    });
}

export function useSaveAiopsSubagentSettings() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: SubagentBudget): Promise<SubagentBudget> => {
            const res = await fetch('/api/settings/aiops', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to save AI Ops settings');
            }
            return json.data.budget as SubagentBudget;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.aiopsSettings.all }),
    });
}

export function useSaveAiopsFeatureSettings() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (features: AiopsFeatureConfig): Promise<AiopsFeatureConfig> => {
            const res = await fetch('/api/settings/aiops', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ features }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to save AI Ops settings');
            }
            return json.data.features as AiopsFeatureConfig;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.aiopsSettings.all }),
    });
}

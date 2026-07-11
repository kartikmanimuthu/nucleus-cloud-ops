/**
 * Agent Ops Defaults
 *
 * Per-tenant default execution config (default model + graph iteration limit)
 * applied to every new run that carries no explicit override. Stored in
 * TenantConfig under 'agent-ops-defaults'. This module owns the config key,
 * validation bounds, and the read path used by the executor.
 */
import { TenantConfigService } from '@/lib/tenant-config-service';
import { env } from '@/env';
import type { AgentOpsDefaultsConfig } from './types';

export const AGENT_OPS_DEFAULTS_KEY = 'agent-ops-defaults';

// Iteration-budget bounds. The floor keeps a run useful; the ceiling protects
// the LLM token budget and the executor from runaway loops.
export const MIN_MAX_ITERATIONS = 10;
export const MAX_MAX_ITERATIONS = 500;

// Fallback when a tenant has not configured Agent Ops defaults yet. Mirrors the
// historical env-driven default so behavior is unchanged until a tenant opts in.
export const FALLBACK_MAX_ITERATIONS = Number(env.AGENT_OPS_MAX_ITERATIONS) || 150;

/**
 * Validate a defaults payload. Returns an error string (for a 400) or null.
 * Both fields are required — this is the "all parameters required" contract.
 */
export function validateAgentOpsDefaults(input: {
    defaultModel?: unknown;
    maxIterations?: unknown;
}): string | null {
    if (typeof input.defaultModel !== 'string' || !input.defaultModel.trim()) {
        return 'defaultModel is required';
    }
    const n = Number(input.maxIterations);
    if (!Number.isInteger(n) || n < MIN_MAX_ITERATIONS || n > MAX_MAX_ITERATIONS) {
        return `maxIterations must be an integer between ${MIN_MAX_ITERATIONS} and ${MAX_MAX_ITERATIONS}`;
    }
    return null;
}

/** Read a tenant's Agent Ops defaults, or null when none are configured. */
export async function getAgentOpsDefaults(tenantId: string): Promise<AgentOpsDefaultsConfig | null> {
    return TenantConfigService.getConfig<AgentOpsDefaultsConfig>(AGENT_OPS_DEFAULTS_KEY, tenantId).catch(() => null);
}

/**
 * Resolve the effective graph iteration limit for a tenant: the configured
 * value, clamped to the allowed range, else the fallback. Never throws.
 */
export async function resolveMaxIterations(tenantId: string): Promise<number> {
    const config = await getAgentOpsDefaults(tenantId);
    if (!config || !Number.isFinite(config.maxIterations)) return FALLBACK_MAX_ITERATIONS;
    return Math.min(MAX_MAX_ITERATIONS, Math.max(MIN_MAX_ITERATIONS, Math.round(config.maxIterations)));
}

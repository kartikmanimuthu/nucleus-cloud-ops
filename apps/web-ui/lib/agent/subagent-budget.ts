/**
 * Sub-agent budget configuration.
 *
 * web-ui runs as a SHARED ECS task, so these limits cannot be purely
 * tenant-controlled: one tenant setting concurrency to 50 would saturate the
 * container's event loop for every co-tenant and flood their LLM provider quota.
 * Env vars are therefore CEILINGS, not overrides:
 *
 *     effective = clamp(tenantConfig ?? default, MIN, envCeiling)
 *
 * Clamping runs on READ (not only on write) so lowering a ceiling retroactively
 * binds config rows written while it was higher.
 *
 * SUBAGENTS_ENABLED=false is an emergency platform kill-switch: tenant config
 * can never re-enable the feature while it is set. Unset means enabled — the
 * per-tenant UI toggle is the normal control.
 */
import { TenantConfigService } from '@/lib/tenant-config-service';

export const SUBAGENT_CONFIG_KEY = 'aiops-subagents';

export interface SubagentBudgetConfig {
    enabled: boolean;
    maxConcurrentSubagents: number;
    maxSubagentsPerRun: number;
    maxSubagentTokensPerRun: number;
    subagentMaxIterations: number;
    subagentTimeoutMs: number;
}

type NumericKey = keyof Omit<SubagentBudgetConfig, 'enabled'>;

interface Bound { min: number; max: number; default: number; envCeiling: string }

/**
 * `max` is the hard platform ceiling. `envCeiling` names an env var that may
 * lower it further (never raise it) for a given deployment.
 */
const BOUNDS_SPEC: Record<NumericKey, Bound> = {
    maxConcurrentSubagents:  { min: 1,      max: 6,       default: 3,       envCeiling: 'SUBAGENT_MAX_CONCURRENCY' },
    maxSubagentsPerRun:      { min: 1,      max: 16,      default: 8,       envCeiling: 'SUBAGENT_MAX_PER_RUN' },
    maxSubagentTokensPerRun: { min: 50_000, max: 1_000_000, default: 400_000, envCeiling: 'SUBAGENT_MAX_TOKENS_PER_RUN' },
    subagentMaxIterations:   { min: 2,      max: 16,      default: 8,       envCeiling: 'SUBAGENT_MAX_ITERATIONS' },
    subagentTimeoutMs:       { min: 30_000, max: 300_000, default: 180_000, envCeiling: 'SUBAGENT_TIMEOUT_MS' },
};

export const BUDGET_BOUNDS = BOUNDS_SPEC;

/** The effective ceiling: the built-in max, lowered (never raised) by env. */
function ceilingFor(key: NumericKey): number {
    const spec = BOUNDS_SPEC[key];
    const fromEnv = Number(process.env[spec.envCeiling]);
    if (!Number.isFinite(fromEnv) || fromEnv <= 0) return spec.max;
    return Math.min(spec.max, Math.round(fromEnv));
}

/**
 * Emergency platform kill-switch. Sub-agents are UI-driven: each tenant's
 * toggle in the AI Ops settings decides, and no env var is required. Setting
 * SUBAGENTS_ENABLED=false disables the feature deployment-wide regardless of
 * tenant config — an ops brake for a shared-ECS incident, not a launch gate.
 */
export function platformSubagentsEnabled(): boolean {
    return process.env.SUBAGENTS_ENABLED !== 'false';
}

export function clampBudget(input: Partial<SubagentBudgetConfig> | null): SubagentBudgetConfig {
    const result: Record<string, unknown> = { enabled: input?.enabled === true };

    for (const key of Object.keys(BOUNDS_SPEC) as NumericKey[]) {
        const spec = BOUNDS_SPEC[key];
        const raw = Number(input?.[key]);
        const value = Number.isFinite(raw) ? Math.round(raw) : spec.default;
        result[key] = Math.min(ceilingFor(key), Math.max(spec.min, value));
    }

    return result as unknown as SubagentBudgetConfig;
}

/**
 * Read a tenant's budget, clamped. Never throws: a config-store failure must
 * degrade to "sub-agents off", not break the chat run.
 */
export async function resolveSubagentBudget(tenantId: string): Promise<SubagentBudgetConfig> {
    if (!platformSubagentsEnabled()) {
        return { ...clampBudget(null), enabled: false };
    }

    const stored = await TenantConfigService
        .getConfig<Partial<SubagentBudgetConfig>>(SUBAGENT_CONFIG_KEY, tenantId)
        .catch(() => null);

    return clampBudget(stored);
}

/** Validate a PUT payload. Returns an error string for a 400, or null. */
export function validateBudgetInput(input: unknown): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return 'Request body must be an object';
    }
    const body = input as Record<string, unknown>;

    if (typeof body.enabled !== 'boolean') {
        return 'enabled must be a boolean';
    }

    for (const key of Object.keys(BOUNDS_SPEC) as NumericKey[]) {
        if (body[key] === undefined) continue;
        // Type-check BEFORE coercing: this function is the trust boundary for the
        // PUT /api/settings/aiops route, and Number() would silently accept
        // `true` as 1 or "3" as 3.
        if (typeof body[key] !== 'number') {
            return `${key} must be a number`;
        }
        const spec = BOUNDS_SPEC[key];
        const value = Number(body[key]);
        const ceiling = ceilingFor(key);
        if (!Number.isInteger(value) || value < spec.min || value > ceiling) {
            return `${key} must be an integer between ${spec.min} and ${ceiling}`;
        }
    }

    return null;
}

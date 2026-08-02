/**
 * AI Ops feature settings — tenant-configured from the AI Ops console
 * ("AI Ops settings" dialog), with NO environment-variable dependency.
 *
 * Every flag here used to be an env kill-switch (CHAT_TRIAGE_ENABLED,
 * *_MEMORY_ENABLED, AUTO_SKILL_CREATION_ENABLED, …). They are now rows on the
 * 'aiops-features' tenant-config key; the defaults below reproduce the old
 * env-unset behavior exactly (everything on, minRules 3, 30 iterations), so a
 * tenant that never opens the settings dialog sees no change.
 *
 * READ PATH: the gates that consume these flags (triage, memory nodes, the
 * agent loops) are hot and often synchronous, so reads go through a small
 * per-tenant TTL cache:
 *   - getAiopsFeatures(tenantId)  — SYNC. Returns the cached value (or the
 *     defaults on a cold cache) and kicks off a background refresh when stale.
 *     A toggle flipped in the UI therefore applies within CACHE_TTL_MS on other
 *     replicas / later runs — good enough for feature flags, and it keeps the
 *     gates free of async plumbing.
 *   - resolveAiopsFeatures(tenantId) — async, always-fresh; used by the
 *     settings API and at graph construction (which is already async).
 */
import { TenantConfigService } from '@/lib/tenant-config-service';

export const AIOPS_FEATURES_KEY = 'aiops-features';

export interface AiopsFeatureConfig {
    /** One cheap classifier call routes chat messages direct-reply vs full agent graph (and auto-picks the skill). */
    chatTriageEnabled: boolean;
    /** In-session compaction for long runs (summary folding + budget-aware window). */
    workingMemoryEnabled: boolean;
    /** Distill one episode per tool-using run; replayed as few-shot experience. */
    episodicMemoryEnabled: boolean;
    /** Learn operating rules from corrections/failures; injected as "Operating rules (learned)". */
    proceduralMemoryEnabled: boolean;
    /** LLM judge (ADD/UPDATE/SUPERSEDE/…) applied when saving memories. */
    memoryReconcileEnabled: boolean;
    /** Autonomous synthesis of sys-<domain> skills from matured procedural rules. */
    autoSkillCreationEnabled: boolean;
    /** Rules whose accessCount reaches this are "matured". */
    autoSkillMaturityThreshold: number;
    /** Matured rules a domain needs before a sys- skill is synthesized. */
    skillSynthesisMinRules: number;
    /** Executor/generator loop cap for both the planning and fast agents. */
    maxIterations: number;
}

type NumericKey = 'autoSkillMaturityThreshold' | 'skillSynthesisMinRules' | 'maxIterations';

export const FEATURE_BOUNDS: Record<NumericKey, { min: number; max: number; default: number }> = {
    autoSkillMaturityThreshold: { min: 1, max: 10, default: 3 },
    skillSynthesisMinRules:     { min: 1, max: 10, default: 3 },
    maxIterations:              { min: 5, max: 50, default: 30 },
};

const BOOLEAN_KEYS = [
    'chatTriageEnabled', 'workingMemoryEnabled', 'episodicMemoryEnabled',
    'proceduralMemoryEnabled', 'memoryReconcileEnabled', 'autoSkillCreationEnabled',
] as const;

export const DEFAULT_FEATURES: AiopsFeatureConfig = Object.freeze({
    chatTriageEnabled: true,
    workingMemoryEnabled: true,
    episodicMemoryEnabled: true,
    proceduralMemoryEnabled: true,
    memoryReconcileEnabled: true,
    autoSkillCreationEnabled: true,
    autoSkillMaturityThreshold: FEATURE_BOUNDS.autoSkillMaturityThreshold.default,
    skillSynthesisMinRules: FEATURE_BOUNDS.skillSynthesisMinRules.default,
    maxIterations: FEATURE_BOUNDS.maxIterations.default,
});

/** Clamp on READ, like the sub-agent budget: a stored row never widens bounds. */
export function clampFeatures(input: Partial<AiopsFeatureConfig> | null): AiopsFeatureConfig {
    const out: Record<string, unknown> = {};
    for (const key of BOOLEAN_KEYS) {
        out[key] = typeof input?.[key] === 'boolean' ? input[key] : DEFAULT_FEATURES[key];
    }
    for (const key of Object.keys(FEATURE_BOUNDS) as NumericKey[]) {
        const spec = FEATURE_BOUNDS[key];
        const raw = Number(input?.[key]);
        const value = Number.isFinite(raw) ? Math.round(raw) : spec.default;
        out[key] = Math.min(spec.max, Math.max(spec.min, value));
    }
    return out as unknown as AiopsFeatureConfig;
}

/** Validate a PUT payload. Returns an error string for a 400, or null. */
export function validateFeaturesInput(input: unknown): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return 'features must be an object';
    }
    const body = input as Record<string, unknown>;
    for (const key of BOOLEAN_KEYS) {
        if (body[key] !== undefined && typeof body[key] !== 'boolean') {
            return `${key} must be a boolean`;
        }
    }
    for (const key of Object.keys(FEATURE_BOUNDS) as NumericKey[]) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== 'number' || !Number.isInteger(body[key] as number)) {
            return `${key} must be an integer`;
        }
        const spec = FEATURE_BOUNDS[key];
        const value = body[key] as number;
        if (value < spec.min || value > spec.max) {
            return `${key} must be between ${spec.min} and ${spec.max}`;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Per-tenant cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: AiopsFeatureConfig; at: number }>();
const inflight = new Set<string>();

async function refresh(tenantId: string): Promise<AiopsFeatureConfig> {
    const stored = await TenantConfigService
        .getConfig<Partial<AiopsFeatureConfig>>(AIOPS_FEATURES_KEY, tenantId)
        .catch(() => null);
    const value = clampFeatures(stored);
    cache.set(tenantId, { value, at: Date.now() });
    return value;
}

/**
 * SYNC read for hot gates. Cold cache returns DEFAULT_FEATURES (identical to
 * the historical env-unset behavior) while a background refresh populates it.
 * Never throws: a config-store failure degrades to defaults.
 */
export function getAiopsFeatures(tenantId?: string | null): AiopsFeatureConfig {
    if (!tenantId) return DEFAULT_FEATURES;
    const hit = cache.get(tenantId);
    if ((!hit || Date.now() - hit.at > CACHE_TTL_MS) && !inflight.has(tenantId)) {
        inflight.add(tenantId);
        void refresh(tenantId)
            .catch(() => { /* degraded to defaults */ })
            .finally(() => inflight.delete(tenantId));
    }
    return hit?.value ?? DEFAULT_FEATURES;
}

/** Always-fresh read; primes the sync cache. For the settings API + graph factories. */
export async function resolveAiopsFeatures(tenantId: string): Promise<AiopsFeatureConfig> {
    return refresh(tenantId);
}

/** Prime the cache after a PUT so the saving replica applies the change immediately. */
export function primeAiopsFeaturesCache(tenantId: string, value: AiopsFeatureConfig): void {
    cache.set(tenantId, { value, at: Date.now() });
}

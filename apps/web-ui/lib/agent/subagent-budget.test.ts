import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: vi.fn() },
}));

import { TenantConfigService } from '@/lib/tenant-config-service';
import {
    clampBudget,
    resolveSubagentBudget,
    validateBudgetInput,
    platformSubagentsEnabled,
    BUDGET_BOUNDS,
} from './subagent-budget';

beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUBAGENTS_ENABLED = 'true';
});
afterEach(() => {
    delete process.env.SUBAGENTS_ENABLED;
    delete process.env.SUBAGENT_MAX_CONCURRENCY;
});

describe('platformSubagentsEnabled', () => {
    it('is false unless SUBAGENTS_ENABLED is exactly "true"', () => {
        delete process.env.SUBAGENTS_ENABLED;
        expect(platformSubagentsEnabled()).toBe(false);
        process.env.SUBAGENTS_ENABLED = 'false';
        expect(platformSubagentsEnabled()).toBe(false);
        process.env.SUBAGENTS_ENABLED = 'true';
        expect(platformSubagentsEnabled()).toBe(true);
    });
});

describe('clampBudget', () => {
    it('returns defaults for null input', () => {
        const budget = clampBudget(null);
        expect(budget.maxConcurrentSubagents).toBe(BUDGET_BOUNDS.maxConcurrentSubagents.default);
        expect(budget.enabled).toBe(false);
    });

    it('clamps a value above the ceiling down', () => {
        expect(clampBudget({ maxConcurrentSubagents: 50 }).maxConcurrentSubagents)
            .toBe(BUDGET_BOUNDS.maxConcurrentSubagents.max);
    });

    it('clamps a value below the floor up', () => {
        expect(clampBudget({ maxSubagentsPerRun: 0 }).maxSubagentsPerRun)
            .toBe(BUDGET_BOUNDS.maxSubagentsPerRun.min);
    });

    it('rounds non-integers', () => {
        expect(clampBudget({ subagentMaxIterations: 7.6 }).subagentMaxIterations).toBe(8);
    });

    it('falls back to the default for non-numeric values', () => {
        expect(clampBudget({ subagentTimeoutMs: 'abc' as unknown as number }).subagentTimeoutMs)
            .toBe(BUDGET_BOUNDS.subagentTimeoutMs.default);
    });

    it('honours an env ceiling lower than the built-in max', () => {
        process.env.SUBAGENT_MAX_CONCURRENCY = '2';
        expect(clampBudget({ maxConcurrentSubagents: 6 }).maxConcurrentSubagents).toBe(2);
    });

    it('IGNORES an env ceiling above the built-in max', () => {
        // The load-bearing multi-tenant isolation invariant: web-ui is a shared
        // ECS task, so no operator misconfiguration may let a tenant exceed the
        // hard cap and saturate the box for co-tenants.
        process.env.SUBAGENT_MAX_CONCURRENCY = '100';
        expect(clampBudget({ maxConcurrentSubagents: 100 }).maxConcurrentSubagents)
            .toBe(BUDGET_BOUNDS.maxConcurrentSubagents.max);
    });
});

describe('resolveSubagentBudget', () => {
    it('returns a disabled budget when the platform kill-switch is off', async () => {
        process.env.SUBAGENTS_ENABLED = 'false';
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true } as never);

        expect((await resolveSubagentBudget('t1')).enabled).toBe(false);
    });

    it('returns tenant config clamped when the platform allows it', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            enabled: true, maxConcurrentSubagents: 99,
        } as never);

        const budget = await resolveSubagentBudget('t1');
        expect(budget.enabled).toBe(true);
        expect(budget.maxConcurrentSubagents).toBe(BUDGET_BOUNDS.maxConcurrentSubagents.max);
    });

    it('returns defaults (disabled) when the tenant has no config', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null as never);
        expect((await resolveSubagentBudget('t1')).enabled).toBe(false);
    });

    it('never throws when the config read fails', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('db down'));
        await expect(resolveSubagentBudget('t1')).resolves.toMatchObject({ enabled: false });
    });
});

describe('validateBudgetInput', () => {
    it('accepts a well-formed payload', () => {
        expect(validateBudgetInput({
            enabled: true, maxConcurrentSubagents: 3, maxSubagentsPerRun: 8,
            maxSubagentTokensPerRun: 400000, subagentMaxIterations: 8, subagentTimeoutMs: 180000,
        })).toBeNull();
    });

    it('rejects a non-object', () => {
        expect(validateBudgetInput(null)).toMatch(/object/i);
    });

    it('rejects a non-boolean enabled', () => {
        expect(validateBudgetInput({ enabled: 'yes' })).toMatch(/enabled/i);
    });

    it('rejects an out-of-range number with a message naming the field', () => {
        expect(validateBudgetInput({ enabled: true, maxConcurrentSubagents: 999 }))
            .toMatch(/maxConcurrentSubagents/);
    });

    it('rejects non-number types rather than coercing them', () => {
        // This function guards the PUT /api/settings/aiops trust boundary, so it
        // must not accept `true` as 1 or "3" as 3.
        expect(validateBudgetInput({ enabled: true, maxConcurrentSubagents: true }))
            .toMatch(/maxConcurrentSubagents/);
        expect(validateBudgetInput({ enabled: true, maxConcurrentSubagents: '3' }))
            .toMatch(/maxConcurrentSubagents/);
        expect(validateBudgetInput({ enabled: true, maxConcurrentSubagents: null }))
            .toMatch(/maxConcurrentSubagents/);
    });
});

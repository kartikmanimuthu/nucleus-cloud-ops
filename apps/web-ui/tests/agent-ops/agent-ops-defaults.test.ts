import { describe, it, expect, vi } from 'vitest';

// getAgentOpsDefaults / resolveMaxIterations read TenantConfig; stub the service
// so the resolver tests exercise clamping logic without a DB.
const mockGetConfig = vi.fn();
vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: (...args: unknown[]) => mockGetConfig(...args) },
}));

import {
    validateAgentOpsDefaults,
    resolveMaxIterations,
    MIN_MAX_ITERATIONS,
    MAX_MAX_ITERATIONS,
    FALLBACK_MAX_ITERATIONS,
} from '../../lib/agent-ops/agent-ops-defaults';

describe('validateAgentOpsDefaults', () => {
    it('accepts a valid payload', () => {
        expect(validateAgentOpsDefaults({ defaultModel: 'anthropic:claude:uuid', maxIterations: 150 })).toBeNull();
    });

    it('requires a non-empty defaultModel', () => {
        expect(validateAgentOpsDefaults({ defaultModel: '', maxIterations: 150 })).toMatch(/defaultModel/);
        expect(validateAgentOpsDefaults({ defaultModel: '   ', maxIterations: 150 })).toMatch(/defaultModel/);
        expect(validateAgentOpsDefaults({ maxIterations: 150 })).toMatch(/defaultModel/);
    });

    it('rejects a non-integer or out-of-range maxIterations', () => {
        expect(validateAgentOpsDefaults({ defaultModel: 'm', maxIterations: 1.5 })).toMatch(/maxIterations/);
        expect(validateAgentOpsDefaults({ defaultModel: 'm', maxIterations: MIN_MAX_ITERATIONS - 1 })).toMatch(/maxIterations/);
        expect(validateAgentOpsDefaults({ defaultModel: 'm', maxIterations: MAX_MAX_ITERATIONS + 1 })).toMatch(/maxIterations/);
        expect(validateAgentOpsDefaults({ defaultModel: 'm' })).toMatch(/maxIterations/);
    });

    it('accepts the boundary values', () => {
        expect(validateAgentOpsDefaults({ defaultModel: 'm', maxIterations: MIN_MAX_ITERATIONS })).toBeNull();
        expect(validateAgentOpsDefaults({ defaultModel: 'm', maxIterations: MAX_MAX_ITERATIONS })).toBeNull();
    });
});

describe('resolveMaxIterations', () => {
    it('returns the fallback when no config is set', async () => {
        mockGetConfig.mockResolvedValueOnce(null);
        expect(await resolveMaxIterations('t1')).toBe(FALLBACK_MAX_ITERATIONS);
    });

    it('returns the configured value when in range', async () => {
        mockGetConfig.mockResolvedValueOnce({ defaultModel: 'm', maxIterations: 200 });
        expect(await resolveMaxIterations('t1')).toBe(200);
    });

    it('clamps an out-of-range configured value into the allowed band', async () => {
        mockGetConfig.mockResolvedValueOnce({ defaultModel: 'm', maxIterations: 99999 });
        expect(await resolveMaxIterations('t1')).toBe(MAX_MAX_ITERATIONS);
        mockGetConfig.mockResolvedValueOnce({ defaultModel: 'm', maxIterations: 1 });
        expect(await resolveMaxIterations('t1')).toBe(MIN_MAX_ITERATIONS);
    });

    it('falls back when the config read throws', async () => {
        mockGetConfig.mockRejectedValueOnce(new Error('db down'));
        expect(await resolveMaxIterations('t1')).toBe(FALLBACK_MAX_ITERATIONS);
    });
});

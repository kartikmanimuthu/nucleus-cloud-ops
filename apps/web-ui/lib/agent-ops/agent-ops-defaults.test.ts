import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfig = vi.fn();
vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: { getConfig: (...a: unknown[]) => getConfig(...a) },
}));
vi.mock('@/env', () => ({ env: { AGENT_OPS_MAX_ITERATIONS: undefined } }));

import { resolveDefaultMode, validateAgentOpsDefaults, FALLBACK_DEFAULT_MODE } from './agent-ops-defaults';

describe('resolveDefaultMode', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the configured mode', async () => {
        getConfig.mockResolvedValue({ defaultModel: 'm', maxIterations: 50, defaultMode: 'deep' });
        await expect(resolveDefaultMode('t1')).resolves.toBe('deep');
    });

    it('falls back to plan when nothing is configured', async () => {
        getConfig.mockResolvedValue(null);
        await expect(resolveDefaultMode('t1')).resolves.toBe(FALLBACK_DEFAULT_MODE);
        expect(FALLBACK_DEFAULT_MODE).toBe('plan');
    });

    it('falls back to plan on an unrecognised stored value', async () => {
        getConfig.mockResolvedValue({ defaultModel: 'm', maxIterations: 50, defaultMode: 'wat' });
        await expect(resolveDefaultMode('t1')).resolves.toBe('plan');
    });

    it('never throws when the config read fails', async () => {
        getConfig.mockRejectedValue(new Error('db down'));
        await expect(resolveDefaultMode('t1')).resolves.toBe('plan');
    });
});

describe('validateAgentOpsDefaults', () => {
    it('accepts a valid deep default', () => {
        expect(validateAgentOpsDefaults({ defaultModel: 'bedrock:x:1', maxIterations: 50, defaultMode: 'deep' })).toBeNull();
    });

    it('rejects an unknown mode', () => {
        expect(validateAgentOpsDefaults({ defaultModel: 'bedrock:x:1', maxIterations: 50, defaultMode: 'turbo' }))
            .toMatch(/defaultMode/);
    });

    it('still accepts a payload with no mode — the field is optional', () => {
        expect(validateAgentOpsDefaults({ defaultModel: 'bedrock:x:1', maxIterations: 50 })).toBeNull();
    });
});

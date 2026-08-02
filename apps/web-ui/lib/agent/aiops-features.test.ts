import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn() } }));
import { TenantConfigService } from '@/lib/tenant-config-service';
import {
    DEFAULT_FEATURES, FEATURE_BOUNDS, clampFeatures, validateFeaturesInput,
    getAiopsFeatures, resolveAiopsFeatures, primeAiopsFeaturesCache,
} from './aiops-features';

describe('clampFeatures', () => {
    it('null input → defaults (identical to the historical env-unset behavior)', () => {
        expect(clampFeatures(null)).toEqual(DEFAULT_FEATURES);
    });

    it('clamps numerics into bounds and ignores junk types', () => {
        const out = clampFeatures({
            chatTriageEnabled: false,
            maxIterations: 9999,
            skillSynthesisMinRules: 0,
            episodicMemoryEnabled: 'yes' as never,
        });
        expect(out.chatTriageEnabled).toBe(false);
        expect(out.maxIterations).toBe(FEATURE_BOUNDS.maxIterations.max);
        expect(out.skillSynthesisMinRules).toBe(FEATURE_BOUNDS.skillSynthesisMinRules.min);
        expect(out.episodicMemoryEnabled).toBe(true); // junk → default
    });
});

describe('validateFeaturesInput', () => {
    it('accepts a partial valid payload', () => {
        expect(validateFeaturesInput({ chatTriageEnabled: true, maxIterations: 20 })).toBeNull();
    });
    it('rejects non-objects, wrong types, and out-of-bounds values', () => {
        expect(validateFeaturesInput(null)).toMatch(/object/);
        expect(validateFeaturesInput({ chatTriageEnabled: 'true' })).toMatch(/boolean/);
        expect(validateFeaturesInput({ maxIterations: 3.5 })).toMatch(/integer/);
        expect(validateFeaturesInput({ maxIterations: 999 })).toMatch(/between/);
    });
});

describe('cache', () => {
    it('sync read returns defaults cold, primed value after, and no tenant → defaults', () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null as never);
        expect(getAiopsFeatures()).toEqual(DEFAULT_FEATURES);
        expect(getAiopsFeatures('t-cold')).toEqual(DEFAULT_FEATURES);
        primeAiopsFeaturesCache('t-primed', { ...DEFAULT_FEATURES, chatTriageEnabled: false });
        expect(getAiopsFeatures('t-primed').chatTriageEnabled).toBe(false);
    });

    it('resolveAiopsFeatures reads the store fresh and clamps', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ maxIterations: 9999 } as never);
        const out = await resolveAiopsFeatures('t-fresh');
        expect(out.maxIterations).toBe(FEATURE_BOUNDS.maxIterations.max);
        // and the sync cache is primed by the resolve
        expect(getAiopsFeatures('t-fresh').maxIterations).toBe(FEATURE_BOUNDS.maxIterations.max);
    });

    it('a store failure degrades to defaults instead of throwing', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('db down'));
        await expect(resolveAiopsFeatures('t-err')).resolves.toEqual(DEFAULT_FEATURES);
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listRecommendationsMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/repository-factory', () => ({
    getRightSizingRepository: () => ({ listRecommendations: listRecommendationsMock }),
}));

import { createGetRightSizingRecommendationsTool } from './right-sizing-tool';

function rec(overrides: Record<string, unknown> = {}) {
    return {
        resourceId: 'i-123', name: 'web-1', resourceType: 'ec2_instances', accountId: '111111111111',
        region: 'us-east-1', finding: 'over_provisioned', currentConfig: 'm5.xlarge', recommendedConfig: 'm5.large',
        estimatedMonthlySavings: 50, confidence: 'high', riskLevel: 'low', status: 'open', rationale: 'CPU < 10%',
        ...overrides,
    };
}

describe('createGetRightSizingRecommendationsTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('scopes the repository call to the bound tenantId, never a model-supplied one', async () => {
        listRecommendationsMock.mockResolvedValue({ recommendations: [] });
        const tool = createGetRightSizingRecommendationsTool('tenant-1');

        await tool.invoke({});

        expect(listRecommendationsMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
    });

    it('passes through optional filters and defaults limit to 25', async () => {
        listRecommendationsMock.mockResolvedValue({ recommendations: [] });
        const tool = createGetRightSizingRecommendationsTool('tenant-1');

        await tool.invoke({ accountId: 'acc-1', resourceType: 'ec2_instances', finding: 'idle' });

        expect(listRecommendationsMock).toHaveBeenCalledWith(expect.objectContaining({
            accountId: 'acc-1', resourceType: 'ec2_instances', finding: 'idle', sort: 'savings', page: 1, limit: 25,
        }));
    });

    it('caps the limit at 100 even when a larger limit is requested', async () => {
        listRecommendationsMock.mockResolvedValue({ recommendations: [] });
        const tool = createGetRightSizingRecommendationsTool('tenant-1');

        await tool.invoke({ limit: 500 });

        expect(listRecommendationsMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('filters out recommendations below minSavings and shapes the returned fields', async () => {
        listRecommendationsMock.mockResolvedValue({
            recommendations: [rec({ estimatedMonthlySavings: 5 }), rec({ resourceId: 'i-456', estimatedMonthlySavings: 100 })],
        });
        const tool = createGetRightSizingRecommendationsTool('tenant-1');

        const raw = await tool.invoke({ minSavings: 20 });
        const parsed = JSON.parse(raw);

        expect(parsed.count).toBe(1);
        expect(parsed.recommendations[0].resourceId).toBe('i-456');
        expect(parsed.recommendations[0]).not.toHaveProperty('currentConfig');
        expect(parsed.recommendations[0].current).toBe('m5.xlarge');
        expect(parsed.totalPotentialMonthlySavings).toBe(100);
    });

    it('defaults minSavings to 0 and sums savings across all returned recommendations', async () => {
        listRecommendationsMock.mockResolvedValue({
            recommendations: [rec({ estimatedMonthlySavings: 10 }), rec({ resourceId: 'i-456', estimatedMonthlySavings: 20 })],
        });
        const tool = createGetRightSizingRecommendationsTool('tenant-1');

        const parsed = JSON.parse(await tool.invoke({}));

        expect(parsed.count).toBe(2);
        expect(parsed.totalPotentialMonthlySavings).toBe(30);
    });
});

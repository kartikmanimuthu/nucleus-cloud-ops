import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getRightSizingRepository } from '@/lib/db/repository-factory';

/**
 * get_right_sizing_recommendations (RS-027).
 *
 * Read-only agent tool returning current right-sizing recommendations for the tenant,
 * optionally filtered. Bound to a tenantId at construction — never accepts a tenantId
 * from the model (no cross-tenant access). No mutation in v1.
 */
export function createGetRightSizingRecommendationsTool(tenantId: string) {
    return tool(
        async (input: {
            accountId?: string;
            resourceType?: string;
            finding?: 'over_provisioned' | 'under_provisioned' | 'idle' | 'optimized';
            minSavings?: number;
            limit?: number;
        }) => {
            const repo = getRightSizingRepository();
            const { recommendations } = await repo.listRecommendations({
                tenantId,
                accountId: input.accountId,
                resourceType: input.resourceType,
                finding: input.finding,
                sort: 'savings',
                page: 1,
                limit: Math.min(input.limit ?? 25, 100),
            });
            const minSavings = input.minSavings ?? 0;
            const filtered = recommendations
                .filter((r) => r.estimatedMonthlySavings >= minSavings)
                .map((r) => ({
                    resourceId: r.resourceId,
                    name: r.name,
                    resourceType: r.resourceType,
                    accountId: r.accountId,
                    region: r.region,
                    finding: r.finding,
                    current: r.currentConfig,
                    recommended: r.recommendedConfig,
                    estimatedMonthlySavings: r.estimatedMonthlySavings,
                    confidence: r.confidence,
                    riskLevel: r.riskLevel,
                    status: r.status,
                    rationale: r.rationale,
                }));
            return JSON.stringify({
                count: filtered.length,
                totalPotentialMonthlySavings: filtered.reduce((s, r) => s + (r.estimatedMonthlySavings || 0), 0),
                recommendations: filtered,
            });
        },
        {
            name: 'get_right_sizing_recommendations',
            description:
                'Get cost-saving right-sizing recommendations for discovered AWS resources (EC2, RDS, EBS, ASG). ' +
                'Returns findings (over/under-provisioned, idle), recommended configs, estimated monthly savings, ' +
                'confidence and risk. Read-only. Optionally filter by accountId, resourceType, finding, or minimum savings.',
            schema: z.object({
                accountId: z.string().optional().describe('Filter to a specific AWS account id'),
                resourceType: z
                    .string()
                    .optional()
                    .describe('Filter by resource type: ec2_instances | rds_db_instances | ec2_volumes | autoscaling_auto_scaling_groups'),
                finding: z
                    .enum(['over_provisioned', 'under_provisioned', 'idle', 'optimized'])
                    .optional()
                    .describe('Filter by finding type'),
                minSavings: z.number().optional().describe('Only return recommendations with at least this monthly $ savings'),
                limit: z.number().optional().describe('Max recommendations to return (default 25, max 100)'),
            }),
        }
    );
}

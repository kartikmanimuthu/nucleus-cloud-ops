import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getResourceGraphRepository } from '@/lib/db/repository-factory';
import { HIDDEN_NODE_TYPES, type GraphPredicate } from '@/lib/resource-graph/graph-constants';

export function createFindPathTool(tenantId: string) {
    return tool(
        async ({ fromId, toId, maxDepth }: { fromId: string; toId: string; maxDepth?: number }) => {
            const repo = getResourceGraphRepository();
            const [from, to] = await Promise.all([
                repo.resolveResourceRef({ tenantId, ref: fromId }),
                repo.resolveResourceRef({ tenantId, ref: toId }),
            ]);

            const missing = [!from && fromId, !to && toId].filter(Boolean);
            if (missing.length) {
                return JSON.stringify({
                    found: false,
                    note: `Not found in inventory for this tenant: ${missing.join(', ')}. Both an id and the name shown in the console are accepted, so this resource may simply not be discovered yet.`,
                });
            }

            const fromType = from!.resourceType;
            const toType = to!.resourceType;

            const result = await repo.findPath({
                tenantId,
                from: { resourceType: fromType, resourceId: from!.resourceId },
                to: { resourceType: toType, resourceId: to!.resourceId },
                maxDepth,
            });

            return JSON.stringify({
                found: result.found,
                from: `${fromType}/${from!.resourceId}`,
                to: `${toType}/${to!.resourceId}`,
                hops: result.hops,
                ...(result.found
                    ? {}
                    : {
                        note: result.frontierExhausted
                            ? `No connection found within ${result.searchedDepth} hops, and the search was capped before exhausting the graph. A longer path may exist.`
                            : `No connection between these two resources within ${result.searchedDepth} hops.`,
                    }),
            });
        },
        {
            name: 'find_path',
            description:
                'Find how two discovered AWS resources are connected — the actual chain of relationships between them, hop by hop. ' +
                'Use this for "is X connected to Y", "how does this instance reach that database", and when tracing an incident between two components. ' +
                'Prefer this over calling get_resource_neighbors repeatedly. Read-only.',
            schema: z.object({
                fromId: z.string().describe('Resource id or name to start from, e.g. i-0abc123, a full ARN, or the name shown in the console'),
                toId: z.string().describe('Resource id or name to reach'),
                maxDepth: z.number().optional().describe('Maximum hops to search (1-5, default 4)'),
            }),
        },
    );
}

export function createQueryGraphTool(tenantId: string) {
    return tool(
        async (input: { predicate: string; resourceType?: string; vpcId?: string; accountId?: string; limit?: number }) => {
            if (input.predicate === 'by-type' && !input.resourceType) {
                return JSON.stringify({ error: 'resourceType is required for the by-type predicate.' });
            }
            if (input.predicate === 'by-vpc' && !input.vpcId) {
                return JSON.stringify({ error: 'vpcId is required for the by-vpc predicate.' });
            }

            const predicate = (input.predicate === 'by-type'
                ? { kind: 'by-type', resourceType: input.resourceType! }
                : input.predicate === 'by-vpc'
                    ? { kind: 'by-vpc', vpcId: input.vpcId! }
                    : { kind: input.predicate }) as GraphPredicate;

            const result = await getResourceGraphRepository().queryGraph({
                tenantId,
                predicate,
                filters: { accountId: input.accountId },
                limit: input.limit,
            });

            return JSON.stringify({
                predicate: input.predicate,
                total: result.total,
                showing: result.nodes.length,
                truncated: result.truncated,
                nodes: result.nodes,
                edges: result.edges,
                ...(result.total === 0 ? { note: 'Nothing in the discovered graph matches this query.' } : {}),
            });
        },
        {
            name: 'query_graph',
            description:
                'Find every discovered AWS resource matching one of a fixed set of questions, together with how those resources connect to each other. ' +
                'Predicates: by-type (all resources of a type), by-vpc (everything in one VPC), internet-facing (public load balancers and CloudFront), ' +
                'unmonitored (no CloudWatch alarm watching it), isolated (no recorded relationships at all). Read-only. ' +
                'Every predicate answers only over what discovery has collected. Absence from a result set means NOT DISCOVERED OR NOT RECORDED, not proven absent — ' +
                'report findings as "nothing recorded" and never as "there is none in this account".',
            schema: z.object({
                predicate: z.enum(['by-type', 'by-vpc', 'internet-facing', 'unmonitored', 'isolated']),
                resourceType: z.string().optional().describe('Required for by-type, e.g. ec2_instances'),
                vpcId: z.string().optional().describe('Required for by-vpc, e.g. vpc-0abc123'),
                accountId: z.string().optional().describe('Restrict to one AWS account'),
                limit: z.number().optional().describe('Maximum nodes to return (default 500)'),
            }),
        },
    );
}

export function createDescribeEnvironmentTool(tenantId: string) {
    return tool(
        async ({ accountId }: { accountId?: string }) => {
            const summary = await getResourceGraphRepository().summarise({ tenantId, accountId });

            return JSON.stringify({
                scope: accountId ?? 'all accounts',
                accounts: summary.accounts,
                excludes: {
                    resourceTypes: [...HIDDEN_NODE_TYPES],
                    edgeCount: 'observation relations (monitors, notifies) and AWS-managed KMS key aliases',
                },
                ...(accountId
                    ? { byResourceType: summary.byResourceType, byRelation: summary.byRelation }
                    : {}),
                ...(summary.accounts.length === 0
                    ? {
                        note: accountId
                            ? `No discovered resources for account ${accountId}. A discovery scan may not have run yet for this account.`
                            : 'No discovered resources for this tenant. A discovery scan may not have run yet.',
                    }
                    : {}),
            });
        },
        {
            name: 'describe_environment',
            description:
                'Get the shape of the estate in one call — graph-visible resource and relationship counts per AWS account (not raw inventory totals: ssm_parameters, iam_roles, observation edges and AWS-managed KMS aliases are excluded), and with an accountId, the breakdown by resource type and relationship for that account. ' +
                'Call this before reasoning about an account you have not looked at yet, instead of guessing its size or composition. Read-only.',
            schema: z.object({
                accountId: z.string().optional().describe('Restrict to one AWS account; omit for every account'),
            }),
        },
    );
}

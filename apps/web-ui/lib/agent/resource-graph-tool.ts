import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getResourceGraphRepository } from '@/lib/db/repository-factory';
import type { ResolvedRef } from '@/lib/db/repositories/resource-graph/interface';

const graphInput = z.object({
    resourceId: z
        .string()
        .describe('The resource id as stored in inventory (e.g. i-0abc123, prod-db, or a full ARN for load balancers and target groups), or the resource name shown in the console'),
    resourceType: z
        .string()
        .optional()
        .describe('Optional. Leave this out unless you are certain — the tool looks the type up from the resource id. e.g. ec2_instances, rds_db_instances'),
    depth: z.number().optional().describe('Hops to traverse (1-5)'),
});

type GraphInput = { resourceId: string; resourceType?: string; depth?: number };

/**
 * Runs a traversal, correcting the resource type when the caller omitted it or got it
 * wrong. A wrong type is silently empty rather than an error — a real run passed "ec2"
 * for an instance whose type is "ec2_instances" and got nothing while six edges existed.
 * The id is unambiguous, so inventory is the authority. Resolution costs at most one
 * extra query, and none at all when the supplied type already returns edges.
 */
async function traverse<T extends { depth: number }>(
    tenantId: string,
    input: GraphInput,
    fetch: (resourceType: string, resourceId: string) => Promise<T[]>,
) {
    const repo = getResourceGraphRepository();
    let ref: ResolvedRef | null | undefined;
    const resolveOnce = async () => {
        if (ref === undefined) ref = await repo.resolveResourceRef({ tenantId, ref: input.resourceId });
        return ref;
    };

    let resourceType = input.resourceType;
    let resourceId = input.resourceId;

    if (!resourceType) {
        const resolved = await resolveOnce();
        resourceType = resolved?.resourceType;
        resourceId = resolved?.resourceId ?? resourceId;
    }

    let edges = resourceType ? await fetch(resourceType, resourceId) : [];

    if (edges.length === 0) {
        const resolved = await resolveOnce();
        if (resolved && (resolved.resourceType !== resourceType || resolved.resourceId !== resourceId)) {
            resourceType = resolved.resourceType;
            resourceId = resolved.resourceId;
            edges = await fetch(resourceType, resourceId);
        }
    }

    // `ref` stays undefined when no lookup was needed, so the happy path costs exactly one
    // query. It is always set by the time edges came back empty.
    return {
        resourceType,
        resourceId,
        edges,
        notInInventory: ref === null,
        ambiguous: ref?.ambiguous,
    };
}

export function createGetResourceNeighborsTool(tenantId: string) {
    return tool(
        async (input: GraphInput) => {
            const { resourceType, resourceId, edges, notInInventory, ambiguous } = await traverse(tenantId, input, (rt, rid) =>
                getResourceGraphRepository().getNeighbors({
                    tenantId,
                    resourceType: rt,
                    resourceId: rid,
                    depth: input.depth,
                }),
            );

            return JSON.stringify({
                resource: `${resourceType ?? 'unknown'}/${resourceId}`,
                ...(ambiguous ? { ambiguous, ambiguityNote: 'That name matched more than one resource; the first was used. Re-run with an exact resource id to disambiguate.' } : {}),
                resourceType,
                count: edges.length,
                edges,
                ...(edges.length === 0
                    ? {
                        note: notInInventory
                            ? 'This resource id was not found in inventory for this tenant, so the graph has nothing for it. It may not be discovered yet.'
                            : 'No edges found. The resource is in inventory but has no recorded relationships.',
                    }
                    : {}),
            });
        },
        {
            name: 'get_resource_neighbors',
            description:
                'Get the directly connected AWS resources for one discovered resource — its VPC, subnets, security groups, volumes, attached load balancers, IAM role, KMS key, and so on. ' +
                'Use this instead of guessing how resources relate, and instead of running AWS CLI describe calls, whenever you need to know what a resource is connected to. Read-only.',
            schema: graphInput,
        },
    );
}

export function createGetBlastRadiusTool(tenantId: string) {
    return tool(
        async (input: GraphInput) => {
            const { resourceType, resourceId, edges, notInInventory, ambiguous } = await traverse(tenantId, input, (rt, rid) =>
                getResourceGraphRepository().getBlastRadius({
                    tenantId,
                    resourceType: rt,
                    resourceId: rid,
                    depth: input.depth,
                }),
            );

            const byDepth: Record<string, typeof edges> = {};
            for (const edge of edges) {
                const key = String(edge.depth);
                (byDepth[key] ||= []).push(edge);
            }

            return JSON.stringify({
                resource: `${resourceType ?? 'unknown'}/${resourceId}`,
                ...(ambiguous ? { ambiguous, ambiguityNote: 'That name matched more than one resource; the first was used. Re-run with an exact resource id to disambiguate.' } : {}),
                resourceType,
                dependentCount: edges.length,
                byDepth,
                ...(edges.length === 0
                    ? {
                        note: notInInventory
                            ? 'This resource id was not found in inventory for this tenant, so the graph has nothing for it. It may not be discovered yet.'
                            : 'No RECORDED dependents. This is not evidence that nothing depends on it. The graph is built from describe-API fields only, so it does not capture application-level connections (a DATABASE_URL or endpoint in config), CIDR-based security group rules, or resource types discovery does not collect. Do NOT conclude it is safe to stop, delete or resize. Verify independently.',
                    }
                    : {}),
            });
        },
        {
            name: 'get_blast_radius',
            description:
                'Find everything that transitively DEPENDS ON a discovered AWS resource — what would be affected if it were stopped, deleted, or degraded. ' +
                'Always call this before recommending or performing a stop, delete, or resize on a resource, and when root-causing an incident to find upstream dependents. ' +
                'Results are grouped by hop distance. Read-only. ' +
                'An empty result means NO EDGE WAS RECORDED, never that the resource is unused: this graph models infrastructure attachment, not runtime traffic. ' +
                'Never state or imply that a resource is safe to stop, delete or resize on the basis of a zero result.',
            schema: graphInput,
        },
    );
}

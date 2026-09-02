'use client';

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';
import type {
    DependencyDirection,
    GraphSummary,
    QueryResult,
    ExpandResult,
    SeedResult,
} from '@/lib/db/repositories/resource-graph/interface';

export interface ResourceGraphAsOf {
    oldestSyncedAt: string | null;
    accountsRepresented: number;
    neverScanned: boolean;
}

export interface ResourceGraphResponse {
    focus: { resourceType: string; resourceId: string; exists: boolean };
    asOf: ResourceGraphAsOf;
    dependents: DependencyDirection;
    dependsOn: DependencyDirection;
}

/**
 * `enabled` is driven by tab activation, so opening the dialog costs nothing for
 * users who never look at Dependencies.
 */
export function useResourceGraph(args: {
    resourceType: string;
    resourceId: string;
    enabled: boolean;
}) {
    return useQuery<ResourceGraphResponse>({
        queryKey: queryKeys.resourceGraph.detail(args.resourceType, args.resourceId),
        enabled: args.enabled && Boolean(args.resourceId),
        queryFn: async () => {
            const params = new URLSearchParams({
                resourceType: args.resourceType,
                resourceId: args.resourceId,
            });
            const res = await fetch(`/api/resource-graph?${params.toString()}`);
            const body = await res.json();
            if (!res.ok || !body.success) {
                throw new Error(body.error ?? 'Failed to load dependencies');
            }
            return body.data as ResourceGraphResponse;
        },
    });
}

export const GRAPH_ENDPOINTS = {
    summary: '/api/resource-graph/summary',
    query: '/api/resource-graph/query',
    expand: '/api/resource-graph/expand',
    seed: '/api/resource-graph/seed',
} as const;

async function getJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok || !body.success) throw new Error(body.error ?? `Request failed: ${res.status}`);
    return body.data as T;
}

export function useGraphSummary() {
    return useQuery({
        queryKey: queryKeys.resourceGraph.summary(),
        queryFn: () => getJson<GraphSummary>(GRAPH_ENDPOINTS.summary),
    });
}

export function useSharedTransitGateways() {
    return useQuery({
        queryKey: queryKeys.resourceGraph.byType('ec2_transit_gateways'),
        queryFn: () => getJson<QueryResult>(
            `${GRAPH_ENDPOINTS.query}?predicate=by-type&resourceType=ec2_transit_gateways`,
        ),
    });
}

export function useAccountVpcs(accountId: string | null) {
    return useQuery({
        queryKey: queryKeys.resourceGraph.byType('ec2_vpcs', accountId ?? undefined),
        queryFn: () => getJson<QueryResult>(
            `${GRAPH_ENDPOINTS.query}?predicate=by-type&resourceType=ec2_vpcs&accountId=${encodeURIComponent(accountId!)}`,
        ),
        enabled: Boolean(accountId),
    });
}

export function useAccountSeed(accountId: string | null) {
    return useQuery({
        queryKey: [...queryKeys.resourceGraph.all, 'seed', accountId ?? 'none'] as const,
        queryFn: () => getJson<SeedResult>(
            `${GRAPH_ENDPOINTS.seed}?accountId=${encodeURIComponent(accountId!)}`,
        ),
        enabled: Boolean(accountId),
    });
}

export function expandResource(resourceId: string) {
    return getJson<ExpandResult>(`${GRAPH_ENDPOINTS.expand}?resourceId=${encodeURIComponent(resourceId)}`);
}

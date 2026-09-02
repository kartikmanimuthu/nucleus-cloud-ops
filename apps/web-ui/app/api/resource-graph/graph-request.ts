import type { GraphFilters } from '@/lib/resource-graph/graph-constants';

export function parseFilters(searchParams: URLSearchParams): GraphFilters {
    const flag = (name: string) => (searchParams.get(name) === 'true' ? true : undefined);

    return {
        accountId: searchParams.get('accountId') ?? undefined,
        includeAwsManagedKeys: flag('includeAwsManagedKeys'),
        includeHiddenTypes: flag('includeHiddenTypes'),
        includeObservation: flag('includeObservation'),
    };
}

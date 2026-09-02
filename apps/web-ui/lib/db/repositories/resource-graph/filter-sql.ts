import {
    AWS_MANAGED_KEY_PREFIX,
    HIDDEN_NODE_TYPES,
    OBSERVATION_RELATIONS,
    type GraphFilters,
} from '@/lib/resource-graph/graph-constants';

// Every value interpolated here is a module constant, never caller input. Aliases are
// supplied by this repository's own SQL, not by a request.
const quoteList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

export function edgeFilterSql(alias: string, filters: GraphFilters): string {
    const parts: string[] = [];

    if (!filters.includeAwsManagedKeys) {
        parts.push(`AND NOT (${alias}."toType" = 'kms_keys' AND ${alias}."toId" LIKE '${AWS_MANAGED_KEY_PREFIX}%')`);
    }

    if (filters.includeObservation === false) {
        parts.push(`AND ${alias}.relation NOT IN (${quoteList(OBSERVATION_RELATIONS)})`);
    }

    return parts.join('\n              ');
}

export function nodeTypeFilterSql(alias: string, filters: GraphFilters): string {
    if (filters.includeHiddenTypes) return '';
    return `AND ${alias}."resourceType" NOT IN (${quoteList(HIDDEN_NODE_TYPES)})`;
}

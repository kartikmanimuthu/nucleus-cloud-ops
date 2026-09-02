import type { Resource, ResourceEdge } from '../types.js';
import { resolvePath, applyTransform } from './edge-path.js';
import { EDGE_SPECS } from './edge-spec.js';
import { CUSTOM_DERIVERS } from './edge-derivers.js';
import { deriveCrossResourceEdges } from './edge-cross-derivers.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('discovery/edge-extractor');


// arn:aws:<service>:<region>:<account>:<resource> — returns the account only when it is not the
// one being scanned, so same-account edges are unchanged.
function accountFromArn(value: string, scanningAccountId: string): string | undefined {
    if (!value.startsWith('arn:')) return undefined;
    const account = value.split(':')[4];
    if (!account || account === scanningAccountId) return undefined;
    return account;
}

export function extractEdges(resources: Resource[], scanningAccountId: string): ResourceEdge[] {
    const seen = new Map<string, ResourceEdge>();

    const add = (edge: ResourceEdge, region: string) => {
        if (!edge.toId || !edge.fromId) return;
        if (edge.fromType === edge.toType && edge.fromId === edge.toId) return;
        seen.set(
            `${edge.fromType}|${edge.fromId}|${edge.relation}|${edge.toType}|${edge.toId}`,
            { ...edge, region },
        );
    };

    for (const resource of resources) {
        if (!resource.resourceId) continue;

        const raw = resource.rawData;
        if (raw === null || typeof raw !== 'object') continue;
        const rawObj = raw as Record<string, unknown>;

        for (const spec of EDGE_SPECS[resource.resourceType] || []) {
            if (spec.when) {
                const actual = resolvePath(rawObj, spec.when.path);
                if (!actual.some((v) => String(v) === spec.when!.equals)) continue;
            }

            const owner = spec.accountPath
                ? resolvePath(rawObj, spec.accountPath).map(String).find((o) => o && o !== scanningAccountId)
                : undefined;

            for (const value of resolvePath(rawObj, spec.path)) {
                if (typeof value === 'object') continue;
                const rawValue = String(value);
                // A cross-account ARN (a centrally managed KMS key, say) reduces to a bare id that
                // matches nothing in this account's inventory. Recording the owning account keeps
                // the edge honest instead of leaving it looking dangling. Opt-in per spec: most
                // ARN-valued fields are same-account by construction.
                const arnOwner = owner ?? (spec.accountFromArn ? accountFromArn(rawValue, scanningAccountId) : undefined);
                for (const toId of applyTransform(rawValue, spec.transform)) {
                    add({
                        fromType: resource.resourceType,
                        fromId: resource.resourceId,
                        relation: spec.relation,
                        toType: spec.toType,
                        toId,
                        ...(arnOwner ? { toAccountId: arnOwner } : {}),
                    }, resource.region);
                }
            }
        }

        const deriver = CUSTOM_DERIVERS[resource.resourceType];
        if (deriver) {
            const ctx = { accountId: scanningAccountId, region: resource.region };
            for (const edge of deriver(rawObj, resource.resourceId, ctx)) add(edge, resource.region);
        }
    }

    // Relationships that need the whole result set, not one resource at a time.
    for (const edge of deriveCrossResourceEdges(resources)) add(edge, edge.region ?? '');

    const edges = Array.from(seen.values());
    log.debug('Extracted edges', { resources: resources.length, edges: edges.length });
    return edges;
}

import { kindOf, kindOrder, type RelationKind } from './relation-kinds';
import type { EnrichedEdge } from '@/lib/db/repositories/resource-graph/interface';

export const PER_SIDE_CAP = 6;
const MAX_HEIGHT = 260;
const ROW_H = 34;
const COL_W = 210;
const INLINE_LABEL_MAX_NODES = 8;

export type Side = 'dependents' | 'focus' | 'dependsOn';

export interface MiniMapNode {
    id: string;
    x: number;
    y: number;
    side: Side;
    label: string;
    resourceType: string;
    resourceId: string;
    kind: RelationKind | null;
    exists: boolean;
}

export interface MiniMapEdge {
    from: string;
    to: string;
    relation: string;
    labelX: number;
    labelY: number;
}

export interface MiniMapLayout {
    nodes: MiniMapNode[];
    edges: MiniMapEdge[];
    width: number;
    height: number;
    overflow: { dependents: number; dependsOn: number };
    showEdgeLabels: boolean;
}

/**
 * Fixed three-column geometry: identical input always yields identical output. A
 * force-directed layout is what turns infrastructure graphs into unreadable webs
 * with overlapping labels, so there is no simulation here at all.
 */
export function computeMiniMap(args: {
    focus: { resourceType: string; resourceId: string; label: string };
    dependents: EnrichedEdge[];
    dependsOn: EnrichedEdge[];
}): MiniMapLayout {
    const pick = (edges: EnrichedEdge[], side: 'dependents' | 'dependsOn') => {
        const order = kindOrder(side);
        const sorted = [...edges].sort((a, b) => {
            const byKind = order.indexOf(kindOf(a.relation)) - order.indexOf(kindOf(b.relation));
            return byKind !== 0 ? byKind : a.other.resourceId.localeCompare(b.other.resourceId);
        });
        return { visible: sorted.slice(0, PER_SIDE_CAP), overflow: Math.max(0, sorted.length - PER_SIDE_CAP) };
    };

    const left = pick(args.dependents, 'dependents');
    const right = pick(args.dependsOn, 'dependsOn');

    const rows = Math.max(left.visible.length, right.visible.length, 1);
    const height = Math.min(MAX_HEIGHT, rows * ROW_H + 24);
    const width = COL_W * 3;
    const midY = height / 2;
    const columnTop = (count: number) => midY - ((count - 1) * ROW_H) / 2;

    const nodes: MiniMapNode[] = [{
        id: 'focus',
        x: COL_W * 1.5,
        y: midY,
        side: 'focus',
        label: args.focus.label,
        resourceType: args.focus.resourceType,
        resourceId: args.focus.resourceId,
        kind: null,
        exists: true,
    }];
    const edges: MiniMapEdge[] = [];

    const place = (
        picked: { visible: EnrichedEdge[] },
        side: 'dependents' | 'dependsOn',
        x: number,
    ) => {
        const top = columnTop(picked.visible.length);
        picked.visible.forEach((e, i) => {
            const id = `${side}:${e.relation}:${e.other.resourceId}`;
            const y = top + i * ROW_H;
            nodes.push({
                id, x, y, side,
                label: e.other.name ?? e.other.resourceId,
                resourceType: e.other.resourceType,
                resourceId: e.other.resourceId,
                kind: kindOf(e.relation),
                exists: e.other.exists,
            });
            edges.push({
                from: side === 'dependents' ? id : 'focus',
                to: side === 'dependents' ? 'focus' : id,
                relation: e.relation,
                labelX: (x + COL_W * 1.5) / 2,
                labelY: (y + midY) / 2,
            });
        });
    };

    place(left, 'dependents', COL_W * 0.5);
    place(right, 'dependsOn', COL_W * 2.5);

    return {
        nodes,
        edges,
        width,
        height,
        overflow: { dependents: left.overflow, dependsOn: right.overflow },
        showEdgeLabels: nodes.length - 1 <= INLINE_LABEL_MAX_NODES,
    };
}

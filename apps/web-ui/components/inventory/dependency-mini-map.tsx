'use client';

import type { MiniMapLayout, MiniMapNode } from '@/lib/resource-graph/mini-map-layout';
import type { RelationKind } from '@/lib/resource-graph/relation-kinds';

/** Kind tints. Tailwind classes only, so dark mode needs no second code path. */
const KIND_FILL: Record<RelationKind, string> = {
    traffic: 'fill-chart-1',
    reachability: 'fill-chart-2',
    containment: 'fill-chart-3',
    attachment: 'fill-chart-4',
    observation: 'fill-chart-5',
    other: 'fill-muted',
};

function Node({ node, onPivot }: { node: MiniMapNode; onPivot: (t: string, i: string) => void }) {
    const isFocus = node.side === 'focus';
    const r = isFocus ? 13 : 10;
    const fill = isFocus ? 'fill-primary' : KIND_FILL[node.kind ?? 'other'];
    const anchor = node.side === 'dependents' ? 'end' : 'start';
    const textX = node.side === 'dependents' ? node.x - r - 6 : node.x + r + 6;

    const body = (
        <>
            <circle
                cx={node.x}
                cy={node.y}
                r={r}
                className={`${fill} ${node.exists ? '' : 'opacity-50'}`}
                strokeDasharray={node.exists ? undefined : '3 2'}
                stroke="currentColor"
                strokeOpacity={isFocus ? 0.9 : 0.25}
            />
            <text
                x={isFocus ? node.x : textX}
                y={isFocus ? node.y + r + 14 : node.y + 4}
                textAnchor={isFocus ? 'middle' : anchor}
                className="fill-foreground text-[11px]"
            >
                {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
            </text>
        </>
    );

    if (isFocus || !node.exists) {
        return <g aria-label={node.label}>{body}</g>;
    }

    return (
        <g
            role="button"
            tabIndex={0}
            aria-label={node.label}
            className="cursor-pointer"
            onClick={() => onPivot(node.resourceType, node.resourceId)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onPivot(node.resourceType, node.resourceId);
            }}
        >
            {body}
        </g>
    );
}

export function DependencyMiniMap({
    layout, onPivot,
}: {
    layout: MiniMapLayout;
    onPivot: (resourceType: string, resourceId: string) => void;
}) {
    const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));

    return (
        <svg
            role="img"
            aria-label="Resource dependency map"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="h-auto w-full text-border"
            style={{ maxHeight: layout.height }}
        >
            {layout.edges.map((e) => {
                const from = nodeById.get(e.from)!;
                const to = nodeById.get(e.to)!;
                return (
                    <g key={`${e.from}->${e.to}`}>
                        <line
                            x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                            stroke="currentColor" strokeWidth={1}
                        />
                        {layout.showEdgeLabels && (
                            <text
                                x={e.labelX} y={e.labelY - 4}
                                textAnchor="middle"
                                className="fill-muted-foreground text-[9px] uppercase tracking-wide"
                            >
                                {e.relation}
                            </text>
                        )}
                    </g>
                );
            })}

            {layout.nodes.map((n) => <Node key={n.id} node={n} onPivot={onPivot} />)}

            {layout.overflow.dependents > 0 && (
                <text x={8} y={layout.height - 6} className="fill-muted-foreground text-[10px]">
                    +{layout.overflow.dependents} more
                </text>
            )}
            {layout.overflow.dependsOn > 0 && (
                <text x={layout.width - 8} y={layout.height - 6} textAnchor="end" className="fill-muted-foreground text-[10px]">
                    +{layout.overflow.dependsOn} more
                </text>
            )}
        </svg>
    );
}

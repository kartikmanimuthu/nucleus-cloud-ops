'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { useResourceGraph } from '@/lib/queries/resource-graph';
import { kindOf, kindOrder, KIND_LABEL, type RelationKind } from '@/lib/resource-graph/relation-kinds';
import { computeMiniMap } from '@/lib/resource-graph/mini-map-layout';
import { DependencyMiniMap } from './dependency-mini-map';
import type { EnrichedEdge } from '@/lib/db/repositories/resource-graph/interface';

const COLLAPSED_ROWS = 8;

function relativeTime(iso: string): string {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} hours ago`;
    return `${Math.round(hours / 24)} days ago`;
}

/** Keeps both ends of an ARN visible — the tail is the distinguishing part. */
function middleTruncate(value: string, max = 44): string {
    if (value.length <= max) return value;
    const keep = Math.floor((max - 1) / 2);
    return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function EdgeRow({ edge, onPivot }: { edge: EnrichedEdge; onPivot: (t: string, i: string) => void }) {
    const label = edge.other.name ?? middleTruncate(edge.other.resourceId);
    const subtitle = `${edge.other.resourceType} · ${edge.relation}`;

    if (!edge.other.exists) {
        return (
            <div className="flex flex-col gap-0.5 rounded-md border border-dashed px-3 py-2 opacity-70">
                <span className="font-mono text-sm">{middleTruncate(edge.other.resourceId)}</span>
                <span className="text-xs text-muted-foreground">{subtitle} · not in inventory</span>
            </div>
        );
    }

    return (
        <button
            type="button"
            onClick={() => onPivot(edge.other.resourceType, edge.other.resourceId)}
            aria-label={`${label}, ${edge.relation}`}
            className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left hover:bg-muted/60"
        >
            <span className="truncate text-sm font-medium">{label}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{subtitle}</span>
        </button>
    );
}

function Direction({
    title, direction, edges, total, truncated, onPivot,
}: {
    title: string;
    direction: 'dependents' | 'dependsOn';
    edges: EnrichedEdge[];
    total: number;
    truncated: boolean;
    onPivot: (t: string, i: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const shown = expanded ? edges : edges.slice(0, COLLAPSED_ROWS);
    const hidden = edges.length - shown.length;

    const byKind = new Map<RelationKind, EnrichedEdge[]>();
    for (const e of shown) {
        const kind = kindOf(e.relation);
        byKind.set(kind, [...(byKind.get(kind) ?? []), e]);
    }

    return (
        <section className="space-y-3">
            <div className="flex items-baseline justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
                <Badge variant="secondary" aria-label={`${title}, ${total} items`}>{total}</Badge>
            </div>

            {edges.length === 0 ? (
                <p className="px-3 text-sm text-muted-foreground">
                    {direction === 'dependents'
                        ? 'Nothing recorded as depending on this resource.'
                        : 'No recorded relationships for this resource.'}
                </p>
            ) : (
                kindOrder(direction)
                    .filter((kind) => byKind.has(kind))
                    .map((kind) => (
                        <div key={kind} className="space-y-1">
                            <p data-testid="kind-heading" className="px-3 text-[11px] uppercase tracking-wide text-muted-foreground">
                                {KIND_LABEL[kind]}
                            </p>
                            {byKind.get(kind)!.map((e) => (
                                <EdgeRow key={`${e.relation}-${e.other.resourceId}`} edge={e} onPivot={onPivot} />
                            ))}
                        </div>
                    ))
            )}

            {hidden > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
                    +{hidden} more
                </Button>
            )}
            {truncated && (
                <p className="px-3 text-xs text-muted-foreground">
                    showing first {edges.length} of {total}
                </p>
            )}
        </section>
    );
}

export function ResourceDependenciesTab({
    resourceType, resourceId, active, onPivot,
}: {
    resourceType: string;
    resourceId: string;
    active: boolean;
    onPivot: (resourceType: string, resourceId: string) => void;
}) {
    const { data, isLoading, isError, error, refetch } = useResourceGraph({
        resourceType, resourceId, enabled: active,
    });

    if (!active) return null;

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Spinner size="sm" /> Loading dependencies…
            </div>
        );
    }

    if (isError || !data) {
        return (
            <div className="space-y-3 p-4">
                <p className="text-sm text-destructive">
                    Could not load dependencies{error instanceof Error ? `: ${error.message}` : ''}.
                </p>
                <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {!data.focus.exists && (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    This resource is not in inventory for this tenant, so the graph has nothing for it.
                    It may not have been discovered yet.
                </p>
            )}

            {(data.dependents.edges.length > 0 || data.dependsOn.edges.length > 0) && (
                <div className="rounded-lg border bg-muted/20 p-4">
                    <DependencyMiniMap
                        layout={computeMiniMap({
                            focus: {
                                resourceType: data.focus.resourceType,
                                resourceId: data.focus.resourceId,
                                label: data.focus.resourceId,
                            },
                            dependents: data.dependents.edges,
                            dependsOn: data.dependsOn.edges,
                        })}
                        onPivot={onPivot}
                    />
                </div>
            )}

            <Direction
                title="Depends on this"
                direction="dependents"
                edges={data.dependents.edges}
                total={data.dependents.total}
                truncated={data.dependents.truncated}
                onPivot={onPivot}
            />
            <Direction
                title="This depends on"
                direction="dependsOn"
                edges={data.dependsOn.edges}
                total={data.dependsOn.total}
                truncated={data.dependsOn.truncated}
                onPivot={onPivot}
            />

            <p className="border-t pt-3 text-xs text-muted-foreground" title={data.asOf.oldestSyncedAt ?? undefined}>
                {data.asOf.neverScanned
                    ? 'At least one account here has never been scanned — this may be incomplete.'
                    : data.asOf.oldestSyncedAt
                        ? `as of ${relativeTime(data.asOf.oldestSyncedAt)}, across ${data.asOf.accountsRepresented} account(s)`
                        : 'freshness unknown'}
            </p>
        </div>
    );
}

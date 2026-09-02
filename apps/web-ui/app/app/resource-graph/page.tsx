'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Waypoints } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { SpinnerOverlay } from '@/components/ui/spinner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAccounts } from '@/lib/queries/accounts';
import { GraphCanvas } from '@/components/resource-graph/graph-canvas';
import { GraphDetailPanel } from '@/components/resource-graph/graph-detail-panel';
import { GraphToolbar } from '@/components/resource-graph/graph-toolbar';
import {
  useGraphSummary,
  useSharedTransitGateways,
  useAccountVpcs,
  useAccountSeed,
  expandResource,
} from '@/lib/queries/resource-graph';
import {
  buildOpeningElements,
  buildExpansionElements,
  buildNodeElements,
  type CyElement,
} from '@/lib/resource-graph/build-elements';
import { NODE_KIND } from '@/lib/resource-graph/graph-theme';
import { kindOf, KIND_LABEL, type RelationKind } from '@/lib/resource-graph/relation-kinds';
import { useGraphCanvasStore } from '@/lib/stores/graph-canvas-store';

const ALL_RELATION_KINDS = Object.keys(KIND_LABEL) as RelationKind[];

function isEdgeElement(element: CyElement): boolean {
  return typeof element.data.source === 'string' && typeof element.data.target === 'string';
}

// Edges are filtered by relation kind; nodes are never dropped by the filter.
function filterByKinds(elements: CyElement[], activeKinds: Set<RelationKind>): CyElement[] {
  return elements.filter((element) => {
    if (!isEdgeElement(element)) return true;
    return activeKinds.has(kindOf(element.data.relation as string));
  });
}

export default function ResourceGraphPage() {
  const summaryQuery = useGraphSummary();
  const gatewaysQuery = useSharedTransitGateways();

  const elements = useGraphCanvasStore((s) => s.elements);
  const selectedId = useGraphCanvasStore((s) => s.selectedId);
  const reset = useGraphCanvasStore((s) => s.reset);
  const addElements = useGraphCanvasStore((s) => s.addElements);
  const markExpanded = useGraphCanvasStore((s) => s.markExpanded);
  const collapse = useGraphCanvasStore((s) => s.collapse);
  const select = useGraphCanvasStore((s) => s.select);

  const rawElementsRef = useRef<CyElement[]>([]);
  const initializedRef = useRef(false);

  const [activeKinds, setActiveKinds] = useState<Set<RelationKind>>(() => new Set(ALL_RELATION_KINDS));
  const activeKindsRef = useRef(activeKinds);
  useEffect(() => {
    activeKindsRef.current = activeKinds;
  }, [activeKinds]);

  const [expandingAccount, setExpandingAccount] = useState<{ nodeId: string; accountId: string } | null>(null);
  const accountVpcsQuery = useAccountVpcs(expandingAccount?.accountId ?? null);

  // The estate view (accounts + shared gateways) is ~100 nodes of summary — useful, but it
  // is not what an infrastructure graph is for. Landing inside the densest account instead
  // puts real resources on screen, which is the view people actually read.
  const [view, setView] = useState<'account' | 'estate'>('account');
  // An explicit limit is required: the repository pages at 10 by default, which named the
  // first ten accounts in the picker and left every other one as a bare 12-digit id.
  const accountsQuery = useAccounts({ limit: 1000 });
  const accountNames = new Map(
    (accountsQuery.data?.accounts ?? []).map((a) => [a.accountId, a.name] as const),
  );
  const [accountId, setAccountId] = useState<string | null>(null);
  const seedQuery = useAccountSeed(view === 'account' ? accountId : null);

  useEffect(() => {
    if (accountId || !summaryQuery.data) return;
    const densest = summaryQuery.data.accounts.reduce<typeof summaryQuery.data.accounts[number] | null>(
      (best, a) => (!best || a.resourceCount > best.resourceCount ? a : best),
      null,
    );
    if (densest) setAccountId(densest.accountId);
  }, [summaryQuery.data, accountId]);

  const mergeRaw = useCallback((newElements: CyElement[]): CyElement[] => {
    const existingIds = new Set(rawElementsRef.current.map((e) => e.data.id as string));
    const additions = newElements.filter((e) => !existingIds.has(e.data.id as string));
    if (additions.length > 0) rawElementsRef.current = [...rawElementsRef.current, ...additions];
    return additions;
  }, []);

  const loadRaw = useCallback(
    (built: CyElement[]) => {
      rawElementsRef.current = built;
      reset(filterByKinds(built, activeKindsRef.current));
      initializedRef.current = true;
    },
    [reset],
  );

  // Account view: the whole account's resources and the edges among them.
  useEffect(() => {
    if (view !== 'account' || !seedQuery.data) return;
    loadRaw(
      buildNodeElements({
        nodes: seedQuery.data.nodes,
        edges: seedQuery.data.edges,
        existingIds: new Set(),
      }),
    );
  }, [view, seedQuery.data, loadRaw]);

  // Estate view: unwrap the summary/gateways wrappers before building elements —
  // passing either wrapper straight in silently yields zero hub nodes.
  useEffect(() => {
    if (view !== 'estate' || !summaryQuery.data || !gatewaysQuery.data) return;
    loadRaw(
      buildOpeningElements({
        accounts: summaryQuery.data.accounts,
        transitGateways: gatewaysQuery.data.nodes,
        accountNames,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- accountNames is rebuilt each
    // render; keying on the query data it derives from avoids an infinite reset loop.
  }, [view, summaryQuery.data, gatewaysQuery.data, accountsQuery.data, loadRaw]);

  useEffect(() => {
    if (summaryQuery.isError) toast.error('Failed to load the resource graph summary.');
  }, [summaryQuery.isError]);

  useEffect(() => {
    if (gatewaysQuery.isError) toast.error('Failed to load shared transit gateways.');
  }, [gatewaysQuery.isError]);

  useEffect(() => {
    if (!expandingAccount || !accountVpcsQuery.data) return;
    const data = accountVpcsQuery.data;
    const newElements = buildNodeElements({
      nodes: data.nodes,
      edges: data.edges,
      existingIds: new Set(rawElementsRef.current.map((e) => e.data.id as string)),
    });
    const additions = mergeRaw(newElements);
    addElements(filterByKinds(additions, activeKindsRef.current));
    markExpanded(expandingAccount.nodeId, Math.max(0, data.total - data.nodes.length));
    setExpandingAccount(null);
  }, [accountVpcsQuery.data, expandingAccount, mergeRaw, addElements, markExpanded]);

  useEffect(() => {
    if (expandingAccount && accountVpcsQuery.isError) {
      toast.error('Failed to load VPCs for this account.');
      setExpandingAccount(null);
    }
  }, [accountVpcsQuery.isError, expandingAccount]);

  const handleExpand = useCallback(
    async (id: string) => {
      const state = useGraphCanvasStore.getState();
      if (state.expanded.has(id)) {
        collapse(id);
        return;
      }

      const node = state.elements.find((e) => e.data.id === id);
      if (!node) return;

      if (node.data.kind === NODE_KIND.account) {
        setExpandingAccount({ nodeId: id, accountId: node.data.accountId as string });
        return;
      }

      try {
        const result = await expandResource(node.data.resourceId as string);
        const existingIds = new Set(rawElementsRef.current.map((e) => e.data.id as string));
        const { elements: newElements, hiddenTotal } = buildExpansionElements({
          expanded: { resourceType: result.resourceType, resourceId: result.resourceId },
          dependents: result.dependents,
          dependsOn: result.dependsOn,
          existingIds,
        });
        const additions = mergeRaw(newElements);

        // Nothing new to draw. In the account view this is the normal case rather than an
        // edge case: the seed already holds every resource in the account, so a node's
        // neighbours are on the canvas before anyone double-clicks it. Marking it expanded
        // here put a "+N more" badge on a node that had just added nothing, and left it in
        // the expanded state — so the next double-click "collapsed" a expansion that never
        // happened, and the one after re-ran this same no-op. Say what is true instead.
        const addedNodes = additions.filter((e) => !isEdgeElement(e)).length;
        if (addedNodes === 0) {
          // Deliberately says nothing about hiddenTotal. That counts edges the expand query
          // did not return (it caps per direction), NOT connections missing from the canvas:
          // the account view's seed already draws every in-account edge, so those same
          // relationships are usually on screen. Reporting them as "beyond the display limit"
          // told the user they were missing something they were looking at.
          toast.info('Every connection for this resource is already on the canvas.');
          return;
        }

        addElements(filterByKinds(additions, activeKindsRef.current));
        markExpanded(id, hiddenTotal);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to expand this resource.');
      }
    },
    [collapse, mergeRaw, addElements, markExpanded],
  );

  // reset() is the only store primitive that can drop already-visible edges, so a
  // filter toggle goes through it — then expanded/hidden/selected state is replayed
  // back on via the normal public actions instead of being lost.
  const handleActiveKindsChange = useCallback(
    (kinds: RelationKind[]) => {
      const next = new Set(kinds);
      setActiveKinds(next);

      const state = useGraphCanvasStore.getState();
      const prevExpanded = state.expanded;
      const prevHidden = state.hiddenCounts;
      const prevSelected = state.selectedId;

      reset(filterByKinds(rawElementsRef.current, next));
      for (const expandedId of prevExpanded) markExpanded(expandedId, prevHidden[expandedId] ?? 0);
      if (prevSelected) select(prevSelected);
    },
    [reset, markExpanded, select],
  );

  const selectedNode = elements.find((e) => e.data.id === selectedId) ?? null;

  const isLoading =
    summaryQuery.isLoading || gatewaysQuery.isLoading || (view === 'account' && seedQuery.isLoading);
  const isError = summaryQuery.isError || gatewaysQuery.isError || seedQuery.isError;
  const isEmpty = initializedRef.current && (summaryQuery.data?.accounts.length ?? 0) === 0;

  const nodeTotal = elements.filter((e) => !isEdgeElement(e)).length;
  const heading =
    view === 'account'
      ? `${accountId ?? ''} · ${nodeTotal} resources`
      : `${summaryQuery.data?.accounts.length ?? 0} accounts · shared infrastructure`;

  return (
    <div className="flex h-[calc(100vh-theme(spacing.16))] flex-col overflow-hidden">
      <PageHeader
        title="Resource Graph"
        description="Explore how accounts, shared infrastructure, and resources connect."
        icon={Waypoints}
        className="px-4 pt-4"
      />

      {isLoading && <SpinnerOverlay label="Loading resource graph…" className="flex-1" />}

      {!isLoading && isError && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p className="text-sm text-muted-foreground">Could not load the resource graph.</p>
          <Button
            variant="outline"
            onClick={() => {
              summaryQuery.refetch();
              gatewaysQuery.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {!isLoading && !isError && isEmpty && (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
          <p className="text-sm font-medium">No resources discovered yet</p>
          <p className="text-sm text-muted-foreground">Run discovery for an account to populate the graph.</p>
        </div>
      )}

      {!isLoading && !isError && !isEmpty && (
        <>
          <div className="flex items-center gap-3 px-4 pb-1 pt-2">
            <div className="inline-flex rounded-md border border-border p-0.5">
              <Button
                size="sm"
                variant={view === 'account' ? 'secondary' : 'ghost'}
                className="h-7 px-3 text-xs"
                onClick={() => setView('account')}
              >
                Account
              </Button>
              <Button
                size="sm"
                variant={view === 'estate' ? 'secondary' : 'ghost'}
                className="h-7 px-3 text-xs"
                onClick={() => setView('estate')}
              >
                Whole estate
              </Button>
            </div>
            {view === 'account' ? (
              <div className="flex items-center gap-2">
                <Select value={accountId ?? undefined} onValueChange={setAccountId}>
                  <SelectTrigger className="h-7 w-[280px] text-xs">
                    <SelectValue placeholder="Select an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {(summaryQuery.data?.accounts ?? [])
                      .slice()
                      .sort((a, b) => b.resourceCount - a.resourceCount)
                      .map((a) => (
                        <SelectItem key={a.accountId} value={a.accountId} className="text-xs">
                          {accountNames.get(a.accountId) ?? a.accountId} · {a.resourceCount}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">{nodeTotal} on canvas</span>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">{heading}</span>
            )}
          </div>

          <GraphToolbar
            elements={elements}
            activeKinds={activeKinds}
            onActiveKindsChange={handleActiveKindsChange}
            onFocus={select}
          />
          <div className="relative min-h-0 flex-1">
            <GraphCanvas onSelect={select} onExpand={handleExpand} />
            {selectedNode && (
              <GraphDetailPanel node={selectedNode.data} onClose={() => select(null)} onExpand={handleExpand} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

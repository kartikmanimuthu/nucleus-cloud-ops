'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition, type LayoutOptions, type StylesheetJson } from 'cytoscape';
// @ts-expect-error cytoscape-fcose ships no type declarations
import fcose from 'cytoscape-fcose';
import { useGraphCanvasStore } from '@/lib/stores/graph-canvas-store';
import type { CyElement } from '@/lib/resource-graph/build-elements';
import { kindOf } from '@/lib/resource-graph/relation-kinds';
import { buildStylesheet, readThemeVars, resolveThemeVars } from './graph-styles';

let fcoseRegistered = false;

function ensureFcoseRegistered() {
  if (fcoseRegistered) return;
  cytoscape.use(fcose);
  fcoseRegistered = true;
}

interface FcoseLayoutOptions extends cytoscape.BaseLayoutOptions {
  name: 'fcose';
  animate: boolean;
  fit: boolean;
  randomize: boolean;
  quality?: 'draft' | 'default' | 'proof';
  nodeRepulsion?: number;
  idealEdgeLength?: number;
  nodeSeparation?: number;
  edgeElasticity?: number;
  gravity?: number;
  gravityRange?: number;
  numIter?: number;
  tile?: boolean;
  tilingPaddingVertical?: number;
  tilingPaddingHorizontal?: number;
  packComponents?: boolean;
  componentSpacing?: number;
  padding?: number;
  nestingFactor?: number;
}

// randomize MUST be true on the very first layout. Without starting positions fcose has
// nothing to relax from and degenerates into a diagonal line with disconnected components
// bricked into a grid. On expansion it flips to false so the existing picture holds still.
// The spacing values are tuned for hub-and-spoke: high repulsion and a long ideal edge give
// each hub room to open into a radial starburst instead of a knot.
function layoutFor(isFirstLoad: boolean): FcoseLayoutOptions {
  return {
    name: 'fcose',
    animate: false,
    fit: isFirstLoad,
    randomize: isFirstLoad,
    quality: 'proof',
    nodeRepulsion: 16000,
    idealEdgeLength: 140,
    nodeSeparation: 130,
    edgeElasticity: 0.4,
    gravity: 0.12,
    gravityRange: 4,
    numIter: 3500,
    tile: true,
    tilingPaddingVertical: 24,
    tilingPaddingHorizontal: 24,
    packComponents: true,
    componentSpacing: 220,
    nestingFactor: 0.15,
    padding: 60,
  };
}

// Selecting a node in a several-hundred-node account is useless if the other 800 stay at
// full strength. Dimming everything outside the neighbourhood is what makes a single
// resource's relationships traceable — and it is also what keeps edge labels readable,
// since only the focused edges carry one.
function applyFocus(cy: Core, id: string | null) {
  cy.batch(() => {
    cy.elements().removeClass('dimmed focused');
    if (!id) return;

    const node = cy.getElementById(id);
    if (node.empty()) return;

    // Ancestors stay lit: dimming a resource's own VPC and subnet boxes would hide the
    // containment that says where it lives.
    const keep = node.closedNeighborhood().union(node.ancestors());
    cy.elements().not(keep).addClass('dimmed');
    keep.addClass('focused');
  });
}

interface Badge {
  id: string;
  count: number;
  x: number;
  y: number;
}

interface GraphCanvasProps {
  onSelect: (id: string | null) => void;
  onExpand: (id: string) => void;
}

function toElementDefinition(element: CyElement): ElementDefinition {
  const data = { ...element.data };
  if (typeof data.source === 'string' && typeof data.target === 'string' && typeof data.relation === 'string') {
    data.relationKind = kindOf(data.relation);
  }
  return { data, classes: element.classes };
}

export function GraphCanvas({ onSelect, onExpand }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const hasFitRef = useRef(false);
  const layoutEpochRef = useRef(0);
  const hiddenCountsRef = useRef<Record<string, number>>({});
  const onSelectRef = useRef(onSelect);
  const onExpandRef = useRef(onExpand);

  const elements = useGraphCanvasStore((s) => s.elements);
  const layoutEpoch = useGraphCanvasStore((s) => s.layoutEpoch);
  const hiddenCounts = useGraphCanvasStore((s) => s.hiddenCounts);
  const select = useGraphCanvasStore((s) => s.select);

  const [nodeCount, setNodeCount] = useState(0);
  const [badges, setBadges] = useState<Badge[]>([]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onExpandRef.current = onExpand;
  }, [onExpand]);

  const restyle = useCallback(() => {
    const cy = cyRef.current;
    const container = containerRef.current;
    if (!cy || !container) return;
    const vars = readThemeVars(container);
    cy.style(resolveThemeVars(buildStylesheet(), vars) as StylesheetJson).update();
  }, []);

  const updateBadges = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const next: Badge[] = [];
    for (const [id, count] of Object.entries(hiddenCountsRef.current)) {
      if (count <= 0) continue;
      const node = cy.getElementById(id);
      if (node.empty()) continue;
      const pos = node.renderedPosition();
      next.push({ id, count, x: pos.x, y: pos.y });
    }
    setBadges(next);
  }, []);

  useEffect(() => {
    ensureFcoseRegistered();
    const container = containerRef.current;
    if (!container) return;

    const cy = cytoscape({ container, elements: [] });
    cyRef.current = cy;
    restyle();

    cy.on('tap', 'node', (evt) => {
      const id = evt.target.id();
      applyFocus(cy, id);
      select(id);
      onSelectRef.current(id);
    });
    cy.on('dbltap', 'node', (evt) => {
      onExpandRef.current(evt.target.id());
    });
    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        applyFocus(cy, null);
        select(null);
        onSelectRef.current(null);
      }
    });
    cy.on('position render pan zoom', updateBadges);

    const observer = new MutationObserver(restyle);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

    return () => {
      observer.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [restyle, select, updateBadges]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const incomingIds = new Set(elements.map((e) => e.data.id as string));
    const toRemove = cy.elements().filter((ele) => !incomingIds.has(ele.id()));
    if (toRemove.length > 0) cy.remove(toRemove);

    const existingIds = new Set(cy.elements().map((ele) => ele.id()));
    const toAdd = elements.filter((e) => !existingIds.has(e.data.id as string)).map(toElementDefinition);

    if (toAdd.length === 0) {
      setNodeCount(cy.nodes().length);
      updateBadges();
      return;
    }

    // A replaced graph is a first load again. Without this the estate view — reached by
    // switching after the account view has already laid out — runs fcose with
    // randomize:false on a set that has almost no edges, and gets the diagonal line the
    // layout comment above warns about.
    if (layoutEpochRef.current !== layoutEpoch) {
      layoutEpochRef.current = layoutEpoch;
      hasFitRef.current = false;
    }

    const isFirstLoad = !hasFitRef.current;
    const lockedNodes = cy.nodes();
    if (!isFirstLoad) lockedNodes.lock();

    const settle = () => {
      if (!isFirstLoad) lockedNodes.unlock();
      hasFitRef.current = true;
      setNodeCount(cy.nodes().length);
      updateBadges();
    };

    // unlock must be guaranteed. fcose's run() is synchronous, so if its computation throws
    // before emitting layoutstop the handler never fires and every existing node stays
    // locked forever — an undraggable graph that reads as frozen.
    try {
      cy.add(toAdd);
      const layout = cy.layout(layoutFor(isFirstLoad) as unknown as LayoutOptions);
      layout.one('layoutstop', settle);
      layout.run();
    } catch {
      settle();
    }
  }, [elements, layoutEpoch, updateBadges]);

  useEffect(() => {
    hiddenCountsRef.current = hiddenCounts;
    updateBadges();
  }, [hiddenCounts, updateBadges]);

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        data-testid="resource-graph-canvas"
        data-node-count={nodeCount}
        className="h-full w-full"
      />
      {badges.map((badge) => (
        <div
          key={badge.id}
          data-testid={`graph-badge-${badge.id}`}
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-sm"
          style={{ left: badge.x, top: badge.y - 20 }}
        >
          +{badge.count} more
        </div>
      ))}
    </div>
  );
}

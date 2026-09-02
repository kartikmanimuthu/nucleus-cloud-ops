import type { StylesheetJson, StylesheetStyle } from 'cytoscape';

export const THEME_VARS = [
  '--background',
  '--foreground',
  '--border',
  '--muted-foreground',
  '--primary',
  '--ring',
  '--card',
] as const;

export function buildStylesheet(): StylesheetJson {
  return [
    // Ring style, not filled discs: a hollow node with a thick coloured border and the
    // canvas colour inside keeps the glyph readable and stops a dense cluster turning into
    // a solid blob of colour.
    {
      selector: 'node',
      style: {
        shape: 'ellipse',
        // Tinted with the node's own colour rather than the canvas colour. A pure-background
        // fill is invisible on a light theme — all that survives is a hairline ring, which is
        // why the graph read as washed out. A low-opacity tint of the type colour keeps the
        // glyph legible while making the node itself visible on white and on near-black.
        'background-color': 'data(color)',
        'background-opacity': 0.18,
        'background-image': 'data(icon)',
        'background-fit': 'none',
        'background-width': '52%',
        'background-height': '52%',
        'background-clip': 'none',
        'background-image-opacity': 0.95,
        'border-width': 3,
        'border-color': 'data(color)',
        'border-opacity': 1,
        width: 'data(size)',
        height: 'data(size)',
        label: 'data(label)',
        color: 'var(--foreground)',
        'font-size': 11,
        'font-weight': 500,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 6,
        'text-wrap': 'ellipsis',
        'text-max-width': 130,
        // Labels vanish when zoomed out instead of overprinting into unreadable mush,
        // then fade in as the user zooms toward a region.
        'min-zoomed-font-size': 7,
        'overlay-opacity': 0,
        'transition-property': 'border-width, border-color, opacity',
        'transition-duration': 140,
      },
    },
    // The type, as a second muted line beneath the name.
    {
      selector: 'node[sublabel]',
      style: {
        'text-wrap': 'wrap',
        'text-max-width': 150,
      },
    },
    {
      selector: 'node.account',
      style: {
        'border-width': 3,
        'font-weight': 600,
      },
    },
    {
      selector: 'node.hub',
      style: {
        shape: 'round-hexagon',
        'border-width': 4,
        'font-size': 14,
        'font-weight': 700,
        'background-width': '46%',
        'background-height': '46%',
        'text-margin-y': 8,
        'z-index': 30,
      },
    },
    // Containment renders as a soft translucent enclosure, never a line. This is what stops
    // one VPC with hundreds of children collapsing the force layout into a ball.
    {
      selector: '$node > node',
      style: {
        shape: 'round-rectangle',
        'background-color': 'data(color)',
        'background-opacity': 0.06,
        'background-image': 'none',
        'border-width': 1.5,
        'border-style': 'dashed',
        'border-color': 'data(color)',
        'border-opacity': 0.45,
        color: 'var(--muted-foreground)',
        'font-size': 11,
        'font-weight': 600,
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -6,
        padding: 26,
        'z-index': 1,
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-color': 'var(--ring)',
        'border-width': 5,
        'z-index': 40,
      },
    },
    // An external node lives in another account — it is context pulled in by a shared edge,
    // not a resource this account owns. Muted fill and a dashed ring keep it from reading
    // as a local resource someone actually has.
    {
      selector: 'node.external',
      style: {
        'border-style': 'dashed',
        'border-color': 'var(--muted-foreground)',
        opacity: 0.7,
      },
    },
    // Declared after .external deliberately: Cytoscape resolves same-specificity selectors in
    // array order, so an external node that is also dimmed would otherwise stay at 0.7 and
    // read as un-dimmed while focus is on something else.
    {
      selector: 'node.dimmed',
      style: { opacity: 0.18 },
    },
    {
      selector: 'edge',
      style: {
        width: 1.2,
        'line-color': 'var(--muted-foreground)',
        'line-opacity': 0.42,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': 'var(--muted-foreground)',
        'arrow-scale': 0.75,
        // Cytoscape font-size is in graph units, so a label grows without limit as the user
        // zooms — at 10x these became solid black bars covering the canvas. Labels are shown
        // only on the focused node's edges, where there are few enough to read.
        label: '',
        'font-size': 8,
        'font-weight': 600,
        'letter-spacing': 0.4,
        color: 'var(--muted-foreground)',
        'text-rotation': 'autorotate',
        'text-background-color': 'var(--background)',
        'text-background-opacity': 0.85,
        'text-background-padding': 2,
        // Edge labels are the first thing to become noise, so they appear only once the
        // user has zoomed in far enough for them to be legible.
        'min-zoomed-font-size': 11,
        'overlay-opacity': 0,
      },
    },
    {
      selector: 'edge.spoke',
      style: {
        width: 1.6,
        'line-color': 'data(color)',
        'line-opacity': 0.5,
        'target-arrow-shape': 'none',
        'curve-style': 'straight',
        label: '',
      },
    },
    {
      selector: 'edge[relationKind = "traffic"]',
      style: {
        width: 2.6,
        'line-color': 'var(--primary)',
        'line-opacity': 0.9,
        'target-arrow-color': 'var(--primary)',
        'arrow-scale': 1,
        'z-index': 20,
      },
    },
    {
      selector: 'edge[relationKind = "reachability"]',
      style: {
        'line-style': 'dashed',
        'line-dash-pattern': [6, 4],
        'line-opacity': 0.6,
      },
    },
    // buildNodeElements turns containment into node parentage, but an expansion returns the
    // raw edge, so these still reach the canvas. Kept faint and arrowless: the enclosure box
    // already says "inside", and a bold line repeating it is the noise that ruins the layout.
    {
      selector: 'edge[relationKind = "containment"]',
      style: {
        width: 1,
        'line-opacity': 0.22,
        'line-style': 'dotted',
        'target-arrow-shape': 'none',
        label: '',
      },
    },
    {
      selector: 'edge[relationKind = "attachment"]',
      style: {
        width: 1,
        'line-opacity': 0.3,
        'target-arrow-shape': 'none',
      },
    },
    {
      selector: 'edge[relationKind = "observation"]',
      style: {
        width: 1,
        'line-style': 'dashed',
        'line-dash-pattern': [2, 5],
        'line-opacity': 0.35,
        'target-arrow-shape': 'none',
        label: '',
      },
    },
    {
      selector: 'edge[relationKind = "other"]',
      style: {
        'line-style': 'dotted',
        'line-opacity': 0.35,
      },
    },
    {
      selector: 'edge:selected',
      style: {
        'line-color': 'var(--ring)',
        'target-arrow-color': 'var(--ring)',
        'line-opacity': 1,
        width: 3,
      },
    },
    {
      selector: 'edge.dimmed',
      style: { opacity: 0.06 },
    },
    // Focus mode: the selected node's own edges get their relation named and pulled forward.
    // Everything else is dimmed, which is what makes a several-hundred-node account readable.
    {
      selector: 'edge.focused',
      style: {
        label: 'data(relationLabel)',
        'line-opacity': 1,
        width: 2.2,
        'z-index': 25,
        color: 'var(--foreground)',
      },
    },
    {
      selector: 'node.focused',
      style: {
        'border-width': 4,
        'z-index': 35,
      },
    },
  ] as StylesheetJson;
}

export function readThemeVars(container: HTMLElement): Record<string, string> {
  const computed = getComputedStyle(container);
  const resolved: Record<string, string> = {};
  for (const name of THEME_VARS) {
    const raw = computed.getPropertyValue(name).trim();
    resolved[`var(${name})`] = raw ? toCytoscapeHsl(raw) : '';
  }
  return resolved;
}

// Tailwind stores these as space-separated channels ("0 0% 100%"). Cytoscape's colour parser
// only accepts the comma form, and silently falls back to BLACK on anything it cannot read —
// which is why every themed colour rendered as a black slab. Commas are the whole fix.
export function toCytoscapeHsl(raw: string): string {
  const parts = raw.split('/')[0].trim().split(/\s+/);
  if (parts.length < 3) return '';
  return `hsl(${parts[0]}, ${parts[1]}, ${parts[2]})`;
}

export function resolveThemeVars(sheet: StylesheetJson, vars: Record<string, string>): StylesheetJson {
  const replace = (value: string) =>
    Object.entries(vars).reduce((acc, [token, resolved]) => (resolved ? acc.split(token).join(resolved) : acc), value);

  const blocks = sheet as unknown as StylesheetStyle[];
  return blocks.map((block) => {
    const resolvedStyle: Record<string, unknown> = {};
    for (const [prop, value] of Object.entries(block.style)) {
      resolvedStyle[prop] = typeof value === 'string' ? replace(value) : value;
    }
    return { selector: block.selector, style: resolvedStyle };
  }) as unknown as StylesheetJson;
}

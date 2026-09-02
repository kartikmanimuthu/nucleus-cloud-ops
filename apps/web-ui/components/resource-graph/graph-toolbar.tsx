'use client';

import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { CyElement } from '@/lib/resource-graph/build-elements';
import { NODE_KIND } from '@/lib/resource-graph/graph-theme';
import { KIND_LABEL, type RelationKind } from '@/lib/resource-graph/relation-kinds';

interface GraphToolbarProps {
  elements: CyElement[];
  activeKinds: Set<RelationKind>;
  onActiveKindsChange: (kinds: RelationKind[]) => void;
  onFocus: (id: string) => void;
}

const RELATION_KINDS = Object.keys(KIND_LABEL) as RelationKind[];

function isNodeElement(element: CyElement): boolean {
  return !(typeof element.data.source === 'string' && typeof element.data.target === 'string');
}

export function GraphToolbar({ elements, activeKinds, onActiveKindsChange, onFocus }: GraphToolbarProps) {
  const [query, setQuery] = useState('');

  const nodes = elements.filter(isNodeElement);
  const accountCount = nodes.filter((n) => n.data.kind === NODE_KIND.account).length;

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    const needle = query.trim().toLowerCase();
    if (!needle) return;

    const match = nodes.find((n) => {
      const id = String(n.data.id).toLowerCase();
      const label = String(n.data.label ?? '').toLowerCase();
      return id === needle || id.includes(needle) || label.includes(needle);
    });

    if (!match) {
      toast.error(`No resource found matching "${query}".`);
      return;
    }
    onFocus(match.data.id as string);
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
      <form onSubmit={handleSearch} className="relative w-64 shrink-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          data-testid="graph-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by id or name…"
          className="pl-8"
        />
      </form>

      <p className="text-sm text-muted-foreground">
        {nodes.length} resources · {accountCount} accounts
      </p>

      <ToggleGroup
        type="multiple"
        value={[...activeKinds]}
        onValueChange={(values) => onActiveKindsChange(values as RelationKind[])}
        className="ml-auto flex-wrap justify-end"
      >
        {/* An unstyled toggle looks identical on and off, so the filters read as dead
            buttons. On = solid and full strength; off = faded with the label struck out. */}
        {RELATION_KINDS.map((kind) => {
          const on = activeKinds.has(kind);
          return (
            <ToggleGroupItem
              key={kind}
              value={kind}
              size="sm"
              aria-label={KIND_LABEL[kind]}
              aria-pressed={on}
              className={
                on
                  ? 'border border-primary/40 bg-primary/15 text-foreground data-[state=on]:bg-primary/15'
                  : 'border border-transparent text-muted-foreground/60 line-through opacity-70'
              }
            >
              {KIND_LABEL[kind]}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </div>
  );
}

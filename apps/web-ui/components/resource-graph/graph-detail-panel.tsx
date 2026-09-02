'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { ExternalLink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface GraphDetailPanelProps {
  node: Record<string, unknown>;
  onClose: () => void;
  onExpand: (id: string) => void;
}

// The scanner writes the literal string 'unknown' when a describe response carries no state
// field at all — S3 buckets and SNS topics have no state in AWS. Showing the word implies we
// failed to read something; an em dash says there is nothing to read.
function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const text = String(value);
  return text.toLowerCase() === 'unknown' ? '—' : text;
}

function Field({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="truncate text-sm">{displayValue(value)}</span>
    </div>
  );
}

// Overlays the canvas rather than sitting in the flex flow, so opening it never
// resizes (and re-fits) the graph underneath.
export function GraphDetailPanel({ node, onClose, onExpand }: GraphDetailPanelProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const id = node.id as string;
  const resourceType = node.resourceType as string | undefined;
  const resourceId = node.resourceId as string | undefined;

  return (
    <div
      data-testid="graph-detail-panel"
      className="absolute right-0 top-0 z-10 flex h-full w-80 flex-col gap-4 border-l bg-background p-4 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="truncate text-sm font-semibold">{String(node.label ?? id)}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          aria-label="Close detail panel"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Resource type" value={resourceType} />
        <Field label="Status" value={node.status} />
        <Field label="Account" value={node.accountId} />
        <Field label="Region" value={node.region} />
      </div>

      <div className="mt-auto flex flex-col gap-2">
        {/* The account view already holds every resource in the account, so there is nothing
            left to fetch — pressing Expand did nothing at all. It now loads neighbours only
            when some are genuinely missing, which is the estate view's account nodes. */}
        <Button onClick={() => onExpand(id)}>Load connections</Button>
        {resourceType && resourceId && (
          <Link
            href={`/app/inventory?resource=${encodeURIComponent(resourceType)}:${encodeURIComponent(resourceId)}`}
            className="inline-flex items-center justify-center gap-1.5 text-sm text-primary hover:underline"
          >
            View in Inventory
            <ExternalLink className="size-3.5" />
          </Link>
        )}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, FileText, Database, Globe, GitBranch } from "lucide-react";

export type KBSource = {
  documentName: string;
  sourceType: string;
  chunkIndex: string;
  totalChunks: string;
  knowledgeBaseId: string;
  dataSourceId: string;
  score: number;
};

interface KBChatSourcesProps {
  sources: KBSource[];
}

function SourceTypeIcon({ sourceType }: { sourceType: string }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-muted-foreground";
  switch (sourceType) {
    case "s3-bucket":   return <Database className={cls} />;
    case "confluence":  return <Globe className={cls} />;
    case "bitbucket":   return <GitBranch className={cls} />;
    default:            return <FileText className={cls} />;
  }
}

function sourceTypeLabel(t: string) {
  return t === "file-upload" ? "File" : t === "s3-bucket" ? "S3" : t.charAt(0).toUpperCase() + t.slice(1);
}

// Deduplicate by documentName — show each source doc once, not per-chunk
function deduplicateSources(sources: KBSource[]): KBSource[] {
  const seen = new Map<string, KBSource>();
  for (const s of sources) {
    const key = `${s.dataSourceId}::${s.documentName}`;
    if (!seen.has(key) || s.score > seen.get(key)!.score) seen.set(key, s);
  }
  return Array.from(seen.values());
}

export function KBChatSources({ sources }: KBChatSourcesProps) {
  const [expanded, setExpanded] = useState(false);

  if (!sources || sources.length === 0) return null;

  const unique = deduplicateSources(sources);

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 text-xs overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      >
        <span className="font-medium text-[11px] tracking-wide uppercase">
          {expanded ? "Hide sources" : `${unique.length} source${unique.length !== 1 ? "s" : ""} used`}
        </span>
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {expanded && (
        <div className="border-t border-border/60 divide-y divide-border/40">
          {unique.map((source, idx) => (
            <div key={`${source.dataSourceId}-${idx}`} className="flex items-center gap-2.5 px-3 py-2 hover:bg-muted/40 transition-colors">
              <SourceTypeIcon sourceType={source.sourceType} />
              <div className="flex-1 min-w-0">
                {/* Full document name — no truncation */}
                <p className="font-medium text-foreground text-[12px] leading-snug break-words">
                  {source.documentName}
                </p>
                <p className="text-muted-foreground text-[11px] mt-0.5">
                  {sourceTypeLabel(source.sourceType)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, FileText, Database, Globe, GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
  const iconClass = "h-3 w-3 mt-0.5 text-muted-foreground shrink-0";
  switch (sourceType) {
    case "s3-bucket":
      return <Database className={iconClass} />;
    case "confluence":
      return <Globe className={iconClass} />;
    case "bitbucket":
      return <GitBranch className={iconClass} />;
    case "file-upload":
    default:
      return <FileText className={iconClass} />;
  }
}

export function KBChatSources({ sources }: KBChatSourcesProps) {
  const [expanded, setExpanded] = useState(false);

  if (!sources || sources.length === 0) return null;

  const displaySources = expanded ? sources : sources.slice(0, 2);

  return (
    <div className="mt-2 rounded-md border border-muted bg-muted/20 text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2 text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="font-medium">
          {expanded
            ? "Hide sources"
            : `Show sources (${sources.length})`}
        </span>
        {expanded ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-muted px-3 py-2 space-y-2">
          {displaySources.map((source, idx) => {
            const chunkNum = Number(source.chunkIndex) + 1;
            const totalChunks = Number(source.totalChunks);
            const scorePercent = (source.score * 100).toFixed(1);

            return (
              <div
                key={`${source.dataSourceId}-${source.chunkIndex}-${idx}`}
                className={cn("flex items-start gap-2 rounded-sm p-1.5")}
              >
                <SourceTypeIcon sourceType={source.sourceType} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium text-foreground truncate max-w-[200px]">
                      {source.documentName}
                    </span>
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                      {scorePercent}% match
                    </Badge>
                  </div>
                  <div className="text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                    <span className="capitalize">{source.sourceType.replace("-", " ")}</span>
                    <span>·</span>
                    <span>
                      Chunk {chunkNum} of {totalChunks}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface AISource {
    resourceId: string;
    name: string;
    resourceType: string;
    region: string;
    accountId: string;
    state: string;
    resourceArn: string;
    relevanceScore: number;
}

interface AskAISourcesProps {
    sources: AISource[];
    onSelectResource?: (source: AISource) => void;
}

export function AskAISources({ sources, onSelectResource }: AskAISourcesProps) {
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
                    {sources.length} source{sources.length !== 1 ? "s" : ""} used
                </span>
                {expanded ? (
                    <ChevronUp className="h-3 w-3" />
                ) : (
                    <ChevronDown className="h-3 w-3" />
                )}
            </button>

            {expanded && (
                <div className="border-t border-muted px-3 py-2 space-y-2">
                    {displaySources.map((source) => (
                        <div
                            key={source.resourceId}
                            className={cn(
                                "flex items-start gap-2 rounded-sm p-1.5",
                                onSelectResource && "cursor-pointer hover:bg-muted/60 transition-colors"
                            )}
                            onClick={() => onSelectResource?.(source)}
                        >
                            <Server className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="font-medium text-foreground truncate max-w-[200px]">
                                        {source.name}
                                    </span>
                                    <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                                        {source.relevanceScore}% match
                                    </Badge>
                                </div>
                                <div className="text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                                    <span>{source.resourceType}</span>
                                    <span>·</span>
                                    <span>{source.region}</span>
                                    <span>·</span>
                                    <span>{source.accountId}</span>
                                </div>
                            </div>
                            {onSelectResource && (
                                <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                            )}
                        </div>
                    ))}
                    {!expanded && sources.length > 2 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 text-xs px-1 text-muted-foreground"
                            onClick={() => setExpanded(true)}
                        >
                            +{sources.length - 2} more
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
}

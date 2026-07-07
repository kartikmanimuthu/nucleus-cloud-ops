"use client";

import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfigTable } from "./shared";
import { buildConsoleUrl } from "@/lib/right-sizing/console-links";
import type { RightSizingRecommendation } from "@/lib/db/repositories/right-sizing/interface";
import type { InventoryResource } from "@/lib/db/repositories/inventory/interface";
import type { UIAccount } from "@/lib/types";

export function ResourceContextPanel({
    recommendation,
    resource,
    account,
}: {
    recommendation: RightSizingRecommendation;
    resource: InventoryResource | null;
    account: UIAccount | null;
}) {
    const consoleUrl = buildConsoleUrl(recommendation.resourceType, recommendation.region, recommendation.resourceId);

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div>
                    <span className="text-muted-foreground">Account: </span>
                    <span className="font-medium">{account?.name ?? "—"}</span>{" "}
                    <span className="font-mono text-xs text-muted-foreground">({recommendation.accountId})</span>
                    <span className="mx-2 text-muted-foreground">·</span>
                    <span className="text-muted-foreground">Region: </span>
                    <span className="font-medium">{recommendation.region}</span>
                </div>
                {consoleUrl && (
                    <Button variant="outline" size="sm" asChild>
                        <a href={consoleUrl} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="h-3.5 w-3.5" />
                            <span className="ml-1">Open in AWS Console</span>
                        </a>
                    </Button>
                )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ConfigTable title="Current" config={recommendation.currentConfig} />
                <ConfigTable title="Recommended" config={recommendation.recommendedConfig} />
            </div>
            {resource?.metadata && Object.keys(resource.metadata).length > 0 && (
                <ConfigTable title="Resource metadata" config={resource.metadata} />
            )}
        </div>
    );
}

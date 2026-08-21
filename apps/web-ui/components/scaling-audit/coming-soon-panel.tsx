"use client";

import { Clock } from "lucide-react";

/** Placeholder for a resource type Scale Sentinel doesn't capture events for
 *  yet — no unified "scaling activity" API exists across RDS/MSK/ElastiCache/
 *  DocDB the way DescribeScalingActivities does for ECS/ASG, so each is its
 *  own future poller, not a parameterization of the existing one. */
export function ComingSoonPanel({ resourceLabel }: { resourceLabel: string }) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-16 text-center text-sm text-muted-foreground">
            <Clock className="h-6 w-6" />
            <p className="font-medium text-foreground">{resourceLabel} tracking is coming soon</p>
            <p className="max-w-sm">
                Scale Sentinel doesn&apos;t capture {resourceLabel} scaling activity yet.
            </p>
        </div>
    );
}

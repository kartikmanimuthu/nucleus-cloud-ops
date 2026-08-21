"use client";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AccountRegion } from "@/components/shared/account-region";
import { useAccount } from "@/lib/queries/accounts";
import type { ScalingEvent } from "@/lib/db/repositories/scaling-audit/interface";
import { capacityChangeHint, formatCapacityChange, formatIstDateTime, scalingTypeLabel, SCOPE_LABELS, SOURCE_LABELS } from "./shared";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-sm">{value ?? "—"}</div>
        </div>
    );
}

export function ScalingEventDetailsDialog({
    event,
    open,
    onOpenChange,
}: {
    event: ScalingEvent | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    // Called before the early return: hooks must run unconditionally, and the
    // query is disabled internally when the id is undefined.
    const accountQuery = useAccount(event?.accountId);

    if (!event) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {event.scope === "asg" ? event.asgName ?? event.resourceId : event.serviceName ?? event.resourceId}
                        <Badge variant="secondary">{scalingTypeLabel(event.scalingType)}</Badge>
                    </DialogTitle>
                    <DialogDescription>
                        {SCOPE_LABELS[event.scope] ?? event.scope} · {SOURCE_LABELS[event.source] ?? event.source} · activity{" "}
                        {event.activityId}
                    </DialogDescription>
                </DialogHeader>

                <ScrollArea className="max-h-[65vh] pr-4">
                    <div className="grid grid-cols-2 gap-4">
                        <Field
                            label="Account / Region"
                            value={
                                <AccountRegion
                                    accountId={event.accountId}
                                    accountName={accountQuery.data?.name}
                                    region={event.region}
                                />
                            }
                        />
                        <Field label="Started (IST)" value={formatIstDateTime(event.startedAt)} />
                        <Field label="Ended (IST)" value={event.endedAt ? formatIstDateTime(event.endedAt) : "—"} />
                        <Field label="Status" value={event.statusCode} />
                        <Field label="Status message" value={event.statusMessage} />
                        <Field
                            label="Capacity change"
                            value={
                                <span title={capacityChangeHint(event.desiredBefore, event.desiredAfter, event.desiredBeforeSource)}>
                                    {formatCapacityChange(event.desiredBefore, event.desiredAfter)}
                                </span>
                            }
                        />
                        <Field
                            label="Peak CPU / Memory before scale"
                            value={
                                event.peakCpuBeforeScale != null || event.peakMemoryBeforeScale != null
                                    ? `${event.peakCpuBeforeScale != null ? `${event.peakCpuBeforeScale.toFixed(2)}% CPU` : "—"}, ${event.peakMemoryBeforeScale != null ? `${event.peakMemoryBeforeScale.toFixed(2)}% Mem` : "—"}`
                                    : "—"
                            }
                        />
                        <Field
                            label="Min/Max bounds"
                            value={
                                event.minBefore != null || event.maxBefore != null || event.minAfter != null || event.maxAfter != null
                                    ? `${event.minBefore ?? "?"}/${event.maxBefore ?? "?"} → ${event.minAfter ?? "?"}/${event.maxAfter ?? "?"}`
                                    : "—"
                            }
                        />
                        <Field label="Policy" value={event.policyName} />
                        <Field label="Alarm" value={event.alarmName} />
                        <Field label="Scheduled action" value={event.scheduledActionName} />
                        <Field label="Not-scaled reason" value={event.notScaledCode} />
                        <Field label="Actor" value={`${event.actor} (${event.actorType})`} />
                        <Field label="Initiated by" value={event.initiatedBy} />
                        <Field label="Inventory match" value={event.inventoryMatched ? "Yes" : "No — resource not found in current inventory"} />
                        <Field label="Captured by run" value={event.capturedByRunId} />
                    </div>

                    <Separator className="my-4" />

                    <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">
                            Raw cause (verbatim from AWS/scheduler — never modified)
                        </div>
                        <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{event.cause}</pre>
                    </div>

                    {event.description && (
                        <div className="mt-3 space-y-2">
                            <div className="text-xs font-medium text-muted-foreground">Description</div>
                            <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{event.description}</pre>
                        </div>
                    )}

                    <div className="mt-3 space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">Raw payload (full API/scheduler record)</div>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                            {JSON.stringify(event.rawPayload, null, 2)}
                        </pre>
                    </div>
                </ScrollArea>
            </DialogContent>
        </Dialog>
    );
}

"use client";

import { useState } from "react";
import {
    useDiscoverySettings,
    useSaveDiscoverySettings,
} from "@/lib/queries/discovery-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/date-utils";
import { useTenant } from "@/lib/tenant-context";

type Period = "daily" | "weekly" | "monthly";

const PRESETS: { label: string; value: Period; description: string }[] = [
    { label: "Daily", value: "daily", description: "Scan all accounts once per day" },
    { label: "Weekly", value: "weekly", description: "Scan all accounts once per week" },
    { label: "Monthly", value: "monthly", description: "Scan all accounts once per month" },
];

export function DiscoverySettings({ canEdit }: { canEdit: boolean }) {
    const { data, isLoading } = useDiscoverySettings();
    if (isLoading) return null;
    const period = (data?.period ?? "daily") as Period;
    // key re-inits the editable period if the persisted value changes.
    return (
        <DiscoverySettingsForm
            key={period}
            canEdit={canEdit}
            initialPeriod={period}
            lastRunAt={data?.lastRunAt ?? null}
            nextEligibleAt={data?.nextEligibleAt ?? null}
        />
    );
}

function DiscoverySettingsForm({
    canEdit,
    initialPeriod,
    lastRunAt,
    nextEligibleAt,
}: {
    canEdit: boolean;
    initialPeriod: Period;
    lastRunAt: string | null;
    nextEligibleAt: string | null;
}) {
    const { timezone } = useTenant();
    const [period, setPeriod] = useState<Period>(initialPeriod);
    const [error, setError] = useState<string | null>(null);
    const saveMutation = useSaveDiscoverySettings();
    const saving = saveMutation.isPending;

    async function handleSave() {
        setError(null);
        try {
            // mutation invalidates the cache → lastRun/nextEligible refresh via props.
            await saveMutation.mutateAsync(period);
            toast.success("Discovery settings saved");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save");
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Search className="h-5 w-5" />
                    Discovery Scan Frequency
                </CardTitle>
                <CardDescription>
                    Configure how often the inventory discovery scan runs for your organization.
                    Discovery is resource-intensive — daily or less frequent is recommended.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-2">
                    <Label>Frequency</Label>
                    <Select
                        value={period}
                        onValueChange={(val) => setPeriod(val as Period)}
                        disabled={!canEdit}
                    >
                        <SelectTrigger className="w-full max-w-xs">
                            <SelectValue placeholder="Select frequency" />
                        </SelectTrigger>
                        <SelectContent>
                            {PRESETS.map((p) => (
                                <SelectItem key={p.value} value={p.value}>
                                    {p.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                        {PRESETS.find((p) => p.value === period)?.description}
                    </p>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                        <p className="text-muted-foreground">Last run</p>
                        <p className="font-medium">{formatDateTime(lastRunAt, "shortDateTime", timezone)}</p>
                    </div>
                    <div>
                        <p className="text-muted-foreground">Next eligible</p>
                        <p className="font-medium">{formatDateTime(nextEligibleAt, "shortDateTime", timezone)}</p>
                    </div>
                </div>

                {canEdit && (
                    <div className="flex items-center gap-3">
                        <Button onClick={handleSave} disabled={saving} size="sm">
                            {saving ? "Saving..." : "Save"}
                        </Button>
                        {error && <span className="text-sm text-destructive">{error}</span>}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

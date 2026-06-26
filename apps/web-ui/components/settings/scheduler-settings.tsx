"use client";

import { useState } from "react";
import {
    useSchedulerSettings,
    useSaveSchedulerSettings,
} from "@/lib/queries/scheduler-settings";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Clock } from "lucide-react";
import { toast } from "sonner";

const PRESETS = [
    { label: "Every 5 minutes", value: 5 },
    { label: "Every 15 minutes", value: 15 },
    { label: "Every 30 minutes", value: 30 },
    { label: "Every hour", value: 60 },
] as const;

type IntervalMinutes = typeof PRESETS[number]["value"];

export function SchedulerSettings({ canEdit }: { canEdit: boolean }) {
    const { data, isLoading } = useSchedulerSettings();
    if (isLoading) return null;
    // Falls back to the default on load error (mirrors the previous behavior).
    const initial = (data?.intervalMinutes ?? 60) as IntervalMinutes;
    // key re-inits the form if the persisted value changes (e.g. after refetch).
    return <SchedulerSettingsForm key={initial} canEdit={canEdit} initialInterval={initial} />;
}

function SchedulerSettingsForm({
    canEdit,
    initialInterval,
}: {
    canEdit: boolean;
    initialInterval: IntervalMinutes;
}) {
    const [intervalMinutes, setIntervalMinutes] = useState<IntervalMinutes>(initialInterval);
    const [error, setError] = useState<string | null>(null);
    const saveMutation = useSaveSchedulerSettings();
    const saving = saveMutation.isPending;

    async function handleSave() {
        setError(null);
        try {
            await saveMutation.mutateAsync(intervalMinutes);
            toast.success("Scheduler settings saved");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save");
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Clock className="h-5 w-5" />
                    Scheduler Frequency
                </CardTitle>
                <CardDescription>
                    Configure how often the resource scheduler runs for your organization.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-2">
                    <Label>Run Interval</Label>
                    <Select
                        value={String(intervalMinutes)}
                        onValueChange={(val) => setIntervalMinutes(Number(val) as IntervalMinutes)}
                        disabled={!canEdit}
                    >
                        <SelectTrigger className="w-full max-w-xs">
                            <SelectValue placeholder="Select interval" />
                        </SelectTrigger>
                        <SelectContent>
                            {PRESETS.map((p) => (
                                <SelectItem key={p.value} value={String(p.value)}>
                                    {p.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
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

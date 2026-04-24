"use client";

import { useState, useEffect } from "react";
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

const PRESETS = [
    { label: "Every 5 minutes", value: 5 },
    { label: "Every 15 minutes", value: 15 },
    { label: "Every 30 minutes", value: 30 },
    { label: "Every hour", value: 60 },
] as const;

type IntervalMinutes = typeof PRESETS[number]["value"];

export function SchedulerSettings({ canEdit }: { canEdit: boolean }) {
    const [intervalMinutes, setIntervalMinutes] = useState<IntervalMinutes>(60);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        fetch("/api/scheduler/settings")
            .then((r) => r.json())
            .then((data) => {
                if (data.success) setIntervalMinutes(data.data.intervalMinutes ?? 60);
            })
            .catch(() => {/* keep default */})
            .finally(() => setLoading(false));
    }, []);

    async function handleSave() {
        setSaving(true);
        setError(null);
        setSuccess(false);
        try {
            const res = await fetch("/api/scheduler/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ scheduleInterval: intervalMinutes }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || "Failed to save");
            setSuccess(true);
            setTimeout(() => setSuccess(false), 3000);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save");
        } finally {
            setSaving(false);
        }
    }

    if (loading) return null;

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
                        {success && <span className="text-sm text-green-600">Saved</span>}
                        {error && <span className="text-sm text-destructive">{error}</span>}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

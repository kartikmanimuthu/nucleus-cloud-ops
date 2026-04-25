"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Search } from "lucide-react";
import { toast } from "sonner";

type Period = "daily" | "weekly" | "monthly";

const PRESETS: { label: string; value: Period; description: string }[] = [
    { label: "Daily", value: "daily", description: "Scan all accounts once per day" },
    { label: "Weekly", value: "weekly", description: "Scan all accounts once per week" },
    { label: "Monthly", value: "monthly", description: "Scan all accounts once per month" },
];

function formatDate(iso: string | null): string {
    if (!iso) return "Never";
    return new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

export function DiscoverySettings({ canEdit }: { canEdit: boolean }) {
    const [period, setPeriod] = useState<Period>("daily");
    const [lastRunAt, setLastRunAt] = useState<string | null>(null);
    const [nextEligibleAt, setNextEligibleAt] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch("/api/settings/discovery")
            .then((r) => r.json())
            .then((data) => {
                if (data.success) {
                    setPeriod(data.data.period);
                    setLastRunAt(data.data.lastRunAt);
                    setNextEligibleAt(data.data.nextEligibleAt);
                }
            })
            .catch(() => setError("Failed to load discovery settings"))
            .finally(() => setLoading(false));
    }, []);

    async function handleSave() {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch("/api/settings/discovery", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ period }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || "Failed to save");
            const refreshed = await fetch("/api/settings/discovery").then(r => r.json());
            if (refreshed.success) {
                setNextEligibleAt(refreshed.data.nextEligibleAt);
            }
            toast.success("Discovery settings saved");
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
                        <p className="font-medium">{formatDate(lastRunAt)}</p>
                    </div>
                    <div>
                        <p className="text-muted-foreground">Next eligible</p>
                        <p className="font-medium">{formatDate(nextEligibleAt)}</p>
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

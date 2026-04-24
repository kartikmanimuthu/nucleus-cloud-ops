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
import { Search } from "lucide-react";

const PERIODS = [
    { label: "Daily", value: "daily" },
    { label: "Weekly", value: "weekly" },
] as const;

type DiscoveryPeriod = typeof PERIODS[number]["value"];

export function DiscoverySettings({ canEdit }: { canEdit: boolean }) {
    const [period, setPeriod] = useState<DiscoveryPeriod>("daily");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        fetch("/api/settings/discovery")
            .then((r) => r.json())
            .then((data) => {
                if (data.success) setPeriod(data.data.period);
            })
            .catch(() => {/* keep default */})
            .finally(() => setLoading(false));
    }, []);

    async function handleSave() {
        setSaving(true);
        setError(null);
        setSuccess(false);
        try {
            const res = await fetch("/api/settings/discovery", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ period }),
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
                    <Search className="h-5 w-5" />
                    Discovery Frequency
                </CardTitle>
                <CardDescription>
                    Configure how often resource discovery scans run for your organization.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-2">
                    <Label>Scan Period</Label>
                    <Select
                        value={period}
                        onValueChange={(val) => setPeriod(val as DiscoveryPeriod)}
                        disabled={!canEdit}
                    >
                        <SelectTrigger className="w-full max-w-xs">
                            <SelectValue placeholder="Select period" />
                        </SelectTrigger>
                        <SelectContent>
                            {PERIODS.map((p) => (
                                <SelectItem key={p.value} value={p.value}>
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

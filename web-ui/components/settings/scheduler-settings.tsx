"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import cronstrue from "cronstrue";

const PRESETS = [
    { label: "Every 15 minutes", value: "*/15 * * * *" },
    { label: "Every 30 minutes", value: "*/30 * * * *" },
    { label: "Every hour", value: "0 * * * *" },
    { label: "Every 2 hours", value: "0 */2 * * *" },
    { label: "Every 6 hours", value: "0 */6 * * *" },
    { label: "Custom", value: "custom" },
];

export function SchedulerSettings({ canEdit }: { canEdit: boolean }) {
    const [cron, setCron] = useState("*/30 * * * *");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        fetch("/api/settings/scheduler")
            .then((r) => r.json())
            .then((data) => {
                if (data.success) setCron(data.data.cron);
            })
            .catch(() => {/* keep default */})
            .finally(() => setLoading(false));
    }, []);

    const isValidCron = cron.trim().split(/\s+/).length === 5;

    let humanReadable = "";
    try {
        humanReadable = isValidCron ? cronstrue.toString(cron) : "";
    } catch {
        humanReadable = "";
    }

    const selectedPreset =
        PRESETS.find((p) => p.value !== "custom" && p.value === cron)?.value ?? "custom";

    async function handleSave() {
        setSaving(true);
        setError(null);
        setSuccess(false);
        try {
            const res = await fetch("/api/settings/scheduler", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cron }),
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
                    <Label>Preset</Label>
                    <Select
                        value={selectedPreset}
                        onValueChange={(val) => {
                            if (val !== "custom") setCron(val);
                        }}
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
                </div>

                <div className="space-y-2">
                    <Label htmlFor="cron-input">Cron Expression</Label>
                    <Input
                        id="cron-input"
                        value={cron}
                        onChange={(e) => setCron(e.target.value)}
                        disabled={!canEdit}
                        className="max-w-xs font-mono"
                        placeholder="*/30 * * * *"
                    />
                    {cron && (
                        <p className={`text-sm ${isValidCron && humanReadable ? "text-muted-foreground" : "text-destructive"}`}>
                            {isValidCron && humanReadable ? humanReadable : "Invalid cron expression"}
                        </p>
                    )}
                </div>

                {canEdit && (
                    <div className="flex items-center gap-3">
                        <Button
                            onClick={handleSave}
                            disabled={saving || !isValidCron}
                            size="sm"
                        >
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

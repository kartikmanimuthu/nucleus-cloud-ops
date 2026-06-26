"use client"

import { useState, useEffect } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"

const PRESETS = [
    { label: "Every hour", value: "0 * * * *" },
    { label: "Daily at 9am", value: "0 9 * * *" },
    { label: "Weekdays at 9am", value: "0 9 * * 1-5" },
    { label: "Weekly Monday 8am", value: "0 8 * * 1" },
    { label: "Custom", value: "custom" },
]

const TIMEZONES = [
    "UTC",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Asia/Kolkata",
    "Asia/Tokyo",
    "Asia/Singapore",
    "Australia/Sydney",
]

interface CronPickerProps {
    value: string
    timezone: string
    onValueChange: (cron: string) => void
    onTimezoneChange: (tz: string) => void
}

export function CronPicker({ value, timezone, onValueChange, onTimezoneChange }: CronPickerProps) {
    const [preset, setPreset] = useState<string>(() => {
        const found = PRESETS.find(p => p.value === value && p.value !== "custom")
        return found ? found.value : "custom"
    })
    const [customCron, setCustomCron] = useState(value)
    const [humanReadable, setHumanReadable] = useState("")

    useEffect(() => {
        let active = true
        import("cronstrue").then(({ default: cronstrue }) => {
            try {
                const text = cronstrue.toString(value, { throwExceptionOnParseError: true })
                if (active) setHumanReadable(text)
            } catch {
                if (active) setHumanReadable("Invalid cron expression")
            }
        })
        return () => { active = false }
    }, [value])

    const handlePresetChange = (p: string) => {
        setPreset(p)
        if (p !== "custom") {
            onValueChange(p)
            setCustomCron(p)
        }
    }

    const handleCustomChange = (v: string) => {
        setCustomCron(v)
        onValueChange(v)
    }

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                    <Label className="text-xs">Schedule</Label>
                    <Select value={preset} onValueChange={handlePresetChange}>
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {PRESETS.map(p => (
                                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="space-y-1.5">
                    <Label className="text-xs">Timezone</Label>
                    <Select value={timezone} onValueChange={onTimezoneChange}>
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {TIMEZONES.map(tz => (
                                <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>
            {preset === "custom" && (
                <div className="space-y-1.5">
                    <Label className="text-xs">Cron Expression</Label>
                    <Input
                        placeholder="e.g. 0 9 * * 1-5"
                        value={customCron}
                        onChange={e => handleCustomChange(e.target.value)}
                        className="font-mono"
                    />
                </div>
            )}
            {humanReadable && (
                <p className="text-xs text-muted-foreground">
                    {humanReadable === "Invalid cron expression"
                        ? <span className="text-destructive">{humanReadable}</span>
                        : <span>🕐 {humanReadable}</span>
                    }
                </p>
            )}
        </div>
    )
}

"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/hooks/use-toast"
import { ArrowLeft, Clock, RefreshCw, Save, AlertCircle, CheckCircle2, Loader2, Play } from "lucide-react"

interface SchedulerSettings {
  intervalMinutes: number
  cronExpression: string
  status: string
  source: string
}

const intervalOptions = [
  { value: "5", label: "Every 5 minutes", description: "High frequency - for real-time monitoring" },
  { value: "15", label: "Every 15 minutes", description: "Medium frequency - balanced approach" },
  { value: "30", label: "Every 30 minutes", description: "Standard frequency - recommended" },
  { value: "60", label: "Every 60 minutes", description: "Low frequency - for less critical workloads" },
]

export default function SchedulerSettingsPage() {
  const router = useRouter()
  const { toast } = useToast()

  const [settings, setSettings] = useState<SchedulerSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedInterval, setSelectedInterval] = useState<string>("30")
  const [hasChanges, setHasChanges] = useState(false)

  const fetchSettings = async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await fetch("/api/scheduler/settings")
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch scheduler settings")
      }

      setSettings(data.data)
      setSelectedInterval(data.data.intervalMinutes?.toString() || "30")
    } catch (err) {
      console.error("Error fetching scheduler settings:", err)
      setError(err instanceof Error ? err.message : "Failed to load settings")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchSettings()
  }, [])

  useEffect(() => {
    if (settings) {
      setHasChanges(parseInt(selectedInterval) !== settings.intervalMinutes)
    }
  }, [selectedInterval, settings])

  const handleSave = async () => {
    try {
      setSaving(true)
      setError(null)

      const response = await fetch("/api/scheduler/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleInterval: parseInt(selectedInterval) })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to update scheduler settings")
      }

      setSettings(data.data)
      setHasChanges(false)

      toast({
        title: "Settings Updated",
        description: `Scheduler will now run every ${selectedInterval} minutes`,
      })
    } catch (err) {
      console.error("Error saving scheduler settings:", err)
      setError(err instanceof Error ? err.message : "Failed to save settings")
      toast({
        variant: "destructive",
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to save settings",
      })
    } finally {
      setSaving(false)
    }
  }

  const handleExecuteNow = async () => {
    try {
      setExecuting(true)
      setError(null)

      const response = await fetch("/api/scheduler/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to execute full scan")
      }

      toast({
        title: "Full Scan Triggered",
        description: "Execution has started in the background. It may take a few minutes to complete.",
      })
    } catch (err) {
      console.error("Error executing full scan:", err)
      setError(err instanceof Error ? err.message : "Failed to execute full scan")
      toast({
        variant: "destructive",
        title: "Execution Failed",
        description: err instanceof Error ? err.message : "Failed to execute full scan",
      })
    } finally {
      setExecuting(false)
    }
  }

  const getIntervalDescription = (interval: string) => {
    return intervalOptions.find(opt => opt.value === interval)?.description || ""
  }

  return (
    <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 bg-background">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Button variant="ghost" size="icon" onClick={() => router.push("/app/schedules")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
              <Clock className="h-8 w-8 text-primary" />
              Scheduler Settings
            </h1>
            <p className="text-muted-foreground">
              Configure when the scheduler cron job should be triggered
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="default"
            onClick={handleExecuteNow}
            disabled={executing || loading}
          >
            {executing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Executing...
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                Execute Now
              </>
            )}
          </Button>
          <Button variant="outline" onClick={fetchSettings} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Loading State */}
      {loading && (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <div className="flex flex-col items-center space-y-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Loading scheduler settings...</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Settings Content */}
      {!loading && settings && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Current Status Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-success" />
                Current Configuration
              </CardTitle>
              <CardDescription>
                The current scheduler trigger settings
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Scheduler Engine</Label>
                <p className="font-mono text-sm bg-muted px-3 py-2 rounded-md">
                  {settings.source}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Current Schedule</Label>
                <p className="font-medium">Every {settings.intervalMinutes} minutes</p>
                <p className="text-xs text-muted-foreground font-mono">
                  {settings.cronExpression}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Update Settings Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-primary" />
                Update Schedule Interval
              </CardTitle>
              <CardDescription>
                Change how frequently the scheduler runs
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Label htmlFor="interval">Schedule Interval</Label>
                <Select value={selectedInterval} onValueChange={setSelectedInterval}>
                  <SelectTrigger id="interval" className="w-full">
                    <SelectValue placeholder="Select interval" />
                  </SelectTrigger>
                  <SelectContent>
                    {intervalOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <div className="flex flex-col">
                          <span>{option.label}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  {getIntervalDescription(selectedInterval)}
                </p>
              </div>

              {hasChanges && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    You have unsaved changes. The scheduler will be updated from {settings.intervalMinutes} minutes to {selectedInterval} minutes.
                  </AlertDescription>
                </Alert>
              )}

              <Button
                className="w-full"
                onClick={handleSave}
                disabled={saving || !hasChanges}
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    Save Changes
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Information Card */}
      <Card>
        <CardHeader>
          <CardTitle>About Scheduler Timing</CardTitle>
        </CardHeader>
        <CardContent className="prose prose-sm dark:prose-invert max-w-none">
          <p className="text-muted-foreground">
            The scheduler is triggered by a pg-boss recurring job at the configured interval.
            When triggered, it evaluates all active schedules and performs start/stop operations
            on resources based on their configured time windows. Each tenant has an independent
            cron schedule stored in their configuration.
          </p>
          <div className="grid gap-4 md:grid-cols-2 mt-4">
            <div className="bg-muted/50 p-4 rounded-lg">
              <h4 className="font-medium mb-2">Lower Intervals (5-15 min)</h4>
              <p className="text-sm text-muted-foreground">
                Provides more precise timing for start/stop operations but increases database load due to more frequent job processing.
              </p>
            </div>
            <div className="bg-muted/50 p-4 rounded-lg">
              <h4 className="font-medium mb-2">Higher Intervals (30-60 min)</h4>
              <p className="text-sm text-muted-foreground">
                More efficient with fewer job executions, but timing for start/stop operations may vary by up to the interval duration.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/hooks/use-toast"
import { ArrowLeft, Clock, RefreshCw, Save, AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"

interface SchedulerSettings {
  scheduleExpression: string
  scheduleInterval: number
  ruleName: string
  ruleState: string
  lastModified?: string
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
  const [error, setError] = useState<string | null>(null)
  const [selectedInterval, setSelectedInterval] = useState<string>("30")
  const [hasChanges, setHasChanges] = useState(false)

  // Fetch current settings
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
      setSelectedInterval(data.data.scheduleInterval?.toString() || "30")
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

  // Track changes
  useEffect(() => {
    if (settings) {
      setHasChanges(parseInt(selectedInterval) !== settings.scheduleInterval)
    }
  }, [selectedInterval, settings])

  // Save settings
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

  const getIntervalDescription = (interval: string) => {
    return intervalOptions.find(opt => opt.value === interval)?.description || ""
  }

  const formatCronExpression = (expression: string) => {
    // Parse cron expression and return human-readable format
    if (expression.includes("0/5")) return "Every 5 minutes"
    if (expression.includes("0,15,30,45")) return "Every 15 minutes"
    if (expression.includes("0,30")) return "Every 30 minutes"
    if (expression.includes("30 *") || expression.includes("0 *")) return "Every hour"
    return expression
  }

  return (
    <div className="flex-1 space-y-6 p-4 md:p-8 pt-6 bg-background">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Button variant="ghost" size="icon" onClick={() => router.push("/schedules")}>
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
        <Button variant="outline" onClick={fetchSettings} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
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
                <Label className="text-sm text-muted-foreground">Rule Name</Label>
                <p className="font-mono text-sm bg-muted px-3 py-2 rounded-md">
                  {settings.ruleName}
                </p>
              </div>
              
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Status</Label>
                <div>
                  <Badge variant={settings.ruleState === "ENABLED" ? "default" : "secondary"}>
                    {settings.ruleState}
                  </Badge>
                </div>
              </div>
              
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Current Schedule</Label>
                <p className="font-medium">{formatCronExpression(settings.scheduleExpression)}</p>
                <p className="text-xs text-muted-foreground font-mono">
                  {settings.scheduleExpression}
                </p>
              </div>
              
              <div className="space-y-2">
                <Label className="text-sm text-muted-foreground">Current Interval</Label>
                <p className="font-medium">{settings.scheduleInterval} minutes</p>
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
                    You have unsaved changes. The scheduler will be updated from {settings.scheduleInterval} minutes to {selectedInterval} minutes.
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
            The scheduler is triggered by an AWS EventBridge rule at the configured interval. 
            When triggered, it evaluates all active schedules and performs start/stop operations 
            on resources based on their configured time windows.
          </p>
          <div className="grid gap-4 md:grid-cols-2 mt-4">
            <div className="bg-muted/50 p-4 rounded-lg">
              <h4 className="font-medium mb-2">Lower Intervals (5-15 min)</h4>
              <p className="text-sm text-muted-foreground">
                Provides more precise timing for start/stop operations but may incur slightly higher costs due to more frequent Lambda invocations.
              </p>
            </div>
            <div className="bg-muted/50 p-4 rounded-lg">
              <h4 className="font-medium mb-2">Higher Intervals (30-60 min)</h4>
              <p className="text-sm text-muted-foreground">
                More cost-effective with fewer invocations, but timing for start/stop operations may vary by up to the interval duration.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

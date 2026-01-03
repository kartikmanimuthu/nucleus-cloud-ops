"use client"

import type React from "react"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Upload, FileText, AlertTriangle, CheckCircle } from "lucide-react"
import { ClientScheduleService } from "@/lib/client-schedule-service"

interface ImportSchedulesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ImportSchedulesDialog({ open, onOpenChange }: ImportSchedulesDialogProps) {
  const [importMethod, setImportMethod] = useState<"file" | "json">("file")
  const [jsonData, setJsonData] = useState("")
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    schedules: number
    errors: string[]
  } | null>(null)

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      setSelectedFile(file)

      // Validate file content
      const reader = new FileReader()
      reader.onload = (e) => {
        try {
          const content = e.target?.result as string
          const parsed = JSON.parse(content)

          if (parsed.schedules && Array.isArray(parsed.schedules)) {
            const validSchedules = parsed.schedules.filter((schedule: any) =>
              schedule.name && schedule.startTime && schedule.endTime
            )

            setValidationResult({
              valid: validSchedules.length > 0,
              schedules: validSchedules.length,
              errors: parsed.schedules.length !== validSchedules.length
                ? ['Some schedules have missing required fields (name, startTime, endTime)']
                : [],
            })
          } else {
            setValidationResult({
              valid: false,
              schedules: 0,
              errors: ['Invalid format: Expected "schedules" array'],
            })
          }
        } catch (error) {
          setValidationResult({
            valid: false,
            schedules: 0,
            errors: ['Invalid JSON file format'],
          })
        }
      }
      reader.readAsText(file)
    }
  }

  const handleJsonValidation = () => {
    try {
      const parsed = JSON.parse(jsonData)

      // Validate JSON structure
      if (parsed.schedules && Array.isArray(parsed.schedules)) {
        const validSchedules = parsed.schedules.filter((schedule: any) =>
          schedule.name && schedule.startTime && schedule.endTime
        )

        const errors = []
        if (parsed.schedules.length !== validSchedules.length) {
          errors.push('Some schedules have missing required fields (name, startTime, endTime)')
        }

        // Check for duplicate schedule names
        const names = parsed.schedules.map((schedule: any) => schedule.name)
        const duplicateNames = names.filter((name: string, index: number) => names.indexOf(name) !== index)
        if (duplicateNames.length > 0) {
          errors.push(`Duplicate schedule names found: ${duplicateNames.join(', ')}`)
        }

        setValidationResult({
          valid: validSchedules.length > 0 && errors.length === 0,
          schedules: validSchedules.length,
          errors,
        })
      } else {
        setValidationResult({
          valid: false,
          schedules: 0,
          errors: ['Invalid format: Expected "schedules" array'],
        })
      }
    } catch (error) {
      setValidationResult({
        valid: false,
        schedules: 0,
        errors: ["Invalid JSON format"],
      })
    }
  }

  const handleImport = async () => {
    if (!validationResult?.valid) return

    try {
      let schedulesToImport: any[] = []

      if (importMethod === "file" && selectedFile) {
        const reader = new FileReader()
        reader.onload = async (e) => {
          const content = e.target?.result as string
          const parsed = JSON.parse(content)
          schedulesToImport = parsed.schedules
          await processImport(schedulesToImport)
        }
        reader.readAsText(selectedFile)
      } else if (importMethod === "json") {
        const parsed = JSON.parse(jsonData)
        schedulesToImport = parsed.schedules
        await processImport(schedulesToImport)
      }
    } catch (error) {
      console.error("Error importing schedules:", error)
    }
  }

  const processImport = async (schedules: any[]) => {
    try {
      for (const schedule of schedules) {
        if (schedule.name && schedule.startTime && schedule.endTime) {
          await ClientScheduleService.createSchedule({
            name: schedule.name,
            description: schedule.description || '',
            starttime: schedule.startTime || schedule.starttime,
            endtime: schedule.endTime || schedule.endtime,
            timezone: schedule.timezone || 'UTC',
            days: schedule.daysOfWeek || schedule.days || ['MON', 'TUE', 'WED', 'THU', 'FRI'],
            active: schedule.isActive !== false,
            createdBy: "import",
          })
        }
      }
      onOpenChange(false)
    } catch (error) {
      console.error("Error processing schedule import:", error)
    }
  }

  const sampleJson = `{
  "schedules": [
    {
      "name": "Production DB Shutdown",
      "description": "Shutdown non-critical databases",
      "startTime": "22:00",
      "endTime": "06:00",
      "timezone": "UTC",
      "daysOfWeek": ["monday", "tuesday", "wednesday", "thursday", "friday"],
      "accounts": ["prod-account-1"],
      "resourceTypes": ["RDS"],
      "resourceTags": "Environment=prod",
      "active": true
    }
  ]
}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <Upload className="h-5 w-5" />
            <span>Import Schedules</span>
          </DialogTitle>
          <DialogDescription>Import schedules from a file or JSON data</DialogDescription>
        </DialogHeader>

        <Tabs value={importMethod} onValueChange={(value) => setImportMethod(value as "file" | "json")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="file">Upload File</TabsTrigger>
            <TabsTrigger value="json">Paste JSON</TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Upload Schedule File</CardTitle>
                <CardDescription>Upload a JSON file containing schedule configurations</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="file">Select File</Label>
                  <Input id="file" type="file" accept=".json" onChange={handleFileSelect} />
                  <p className="text-xs text-muted-foreground">Supported formats: JSON (.json)</p>
                </div>

                {selectedFile && (
                  <div className="p-3 bg-muted rounded-lg">
                    <div className="flex items-center space-x-2">
                      <FileText className="h-4 w-4" />
                      <span className="text-sm font-medium">{selectedFile.name}</span>
                      <span className="text-xs text-muted-foreground">
                        ({(selectedFile.size / 1024).toFixed(1)} KB)
                      </span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="json" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Paste JSON Data</CardTitle>
                <CardDescription>Paste your schedule configuration in JSON format</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="json">JSON Data</Label>
                  <Textarea
                    id="json"
                    value={jsonData}
                    onChange={(e) => setJsonData(e.target.value)}
                    placeholder="Paste your JSON data here..."
                    rows={8}
                    className="font-mono text-sm"
                  />
                </div>

                <Button onClick={handleJsonValidation} variant="outline" size="sm">
                  Validate JSON
                </Button>

                <details className="space-y-2">
                  <summary className="text-sm font-medium cursor-pointer">View Sample JSON Format</summary>
                  <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto">{sampleJson}</pre>
                </details>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Validation Results */}
        {validationResult && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                {validationResult.valid ? (
                  <CheckCircle className="h-5 w-5 text-success" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                )}
                <span>Validation Results</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {validationResult.valid ? (
                <div className="space-y-2">
                  <p className="text-sm text-success dark:text-success">✓ Valid format detected</p>
                  <p className="text-sm text-muted-foreground">
                    Found {validationResult.schedules} schedule{validationResult.schedules !== 1 ? "s" : ""} ready to
                    import
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-destructive dark:text-destructive">✗ Validation failed</p>
                  <ul className="text-sm text-muted-foreground space-y-1">
                    {validationResult.errors.map((error, index) => (
                      <li key={index}>• {error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={!validationResult?.valid}>
            <Upload className="mr-2 h-4 w-4" />
            Import Schedules
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

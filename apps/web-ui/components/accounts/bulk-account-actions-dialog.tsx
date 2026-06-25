"use client"

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
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { CheckCircle, XCircle, RefreshCw, Download, Settings, Trash2 } from "lucide-react"

interface BulkAccountActionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedAccounts: string[]
  onClearSelection: () => void
}

const bulkActions = [
  { value: "activate", label: "Activate Accounts", icon: CheckCircle, description: "Enable selected accounts" },
  { value: "deactivate", label: "Deactivate Accounts", icon: XCircle, description: "Disable selected accounts" },
  {
    value: "validate",
    label: "Validate Connections",
    icon: RefreshCw,
    description: "Test connections for selected accounts",
  },
  { value: "export", label: "Export Accounts", icon: Download, description: "Download selected accounts as JSON" },
  {
    value: "delete",
    label: "Delete Accounts",
    icon: Trash2,
    description: "Permanently delete selected accounts",
    destructive: true,
  },
]

export function BulkAccountActionsDialog({
  open,
  onOpenChange,
  selectedAccounts,
  onClearSelection,
}: BulkAccountActionsDialogProps) {
  const [selectedAction, setSelectedAction] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  const handleExecute = async () => {
    if (!selectedAction) return

    try {
      setIsLoading(true)

      // Implement bulk action API calls
      const promises = selectedAccounts.map(async (accountId) => {
        const endpoint = selectedAction === 'delete'
          ? `/api/accounts/${accountId}`
          : `/api/accounts/${accountId}/${selectedAction}`

        const method = selectedAction === 'delete' ? 'DELETE' : 'POST'

        return fetch(endpoint, {
          method,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      })

      await Promise.all(promises)

      console.log(`Bulk ${selectedAction} completed for ${selectedAccounts.length} accounts`)
      onClearSelection()
      onOpenChange(false)
      setSelectedAction("")
    } catch (error: any) {
      console.error("Error executing bulk action:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const selectedActionData = bulkActions.find((action) => action.value === selectedAction)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <Settings className="h-5 w-5" />
            <span>Bulk Account Actions</span>
          </DialogTitle>
          <DialogDescription>
            Perform actions on {selectedAccounts.length} selected account{selectedAccounts.length !== 1 ? "s" : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center space-x-2">
            <span className="text-sm text-muted-foreground">Selected:</span>
            <Badge variant="secondary">{selectedAccounts.length} accounts</Badge>
          </div>

          <Separator />

          <div className="space-y-2">
            <label className="text-sm font-medium">Choose Action</label>
            <Select value={selectedAction} onValueChange={setSelectedAction}>
              <SelectTrigger>
                <SelectValue placeholder="Select an action to perform" />
              </SelectTrigger>
              <SelectContent>
                {bulkActions.map((action) => (
                  <SelectItem key={action.value} value={action.value}>
                    <div className="flex items-center space-x-2">
                      <action.icon className="h-4 w-4" />
                      <span>{action.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedActionData && (
            <div
              className={`p-3 rounded-lg border ${selectedActionData.destructive
                  ? "bg-destructive/10 border-red-200 dark:bg-red-950 dark:border-red-800"
                  : "bg-info/10 border-blue-200 dark:bg-blue-950 dark:border-blue-800"
                }`}
            >
              <div className="flex items-center space-x-2 mb-1">
                <selectedActionData.icon
                  className={`h-4 w-4 ${selectedActionData.destructive
                      ? "text-destructive dark:text-destructive"
                      : "text-info dark:text-blue-400"
                    }`}
                />
                <span
                  className={`font-medium text-sm ${selectedActionData.destructive
                      ? "text-red-800 dark:text-red-200"
                      : "text-blue-800 dark:text-blue-200"
                    }`}
                >
                  {selectedActionData.label}
                </span>
              </div>
              <p
                className={`text-sm ${selectedActionData.destructive ? "text-red-700" : "text-blue-700"
                  }`}
              >
                {selectedActionData.description}
              </p>
              {selectedActionData.destructive && (
                <p className="text-xs text-destructive dark:text-destructive mt-2">
                  ⚠️ This action will also delete all associated schedules and cannot be undone
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleExecute}
            disabled={!selectedAction}
            variant={selectedActionData?.destructive ? "destructive" : "default"}
          >
            {selectedActionData?.destructive ? "Delete" : "Execute"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

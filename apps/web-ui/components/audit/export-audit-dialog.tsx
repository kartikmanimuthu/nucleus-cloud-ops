"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Download, FileText, Table2 } from "lucide-react";
import { AuditLog } from "@/lib/types";

interface ExportAuditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  logs: AuditLog[];
}

export function ExportAuditDialog({
  open,
  onOpenChange,
  logs = [],
}: ExportAuditDialogProps) {
  const [exportFormat, setExportFormat] = useState<"csv" | "json">("csv");
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [selectedFields, setSelectedFields] = useState<string[]>([
    "timestamp",
    "eventType",
    "action",
    "user",
    "resource",
    "status",
    "details",
  ]);
  const [isExporting, setIsExporting] = useState(false);

  const availableFields = [
    { id: "timestamp", label: "Timestamp" },
    { id: "eventType", label: "Event Type" },
    { id: "action", label: "Action" },
    { id: "user", label: "User" },
    { id: "userType", label: "User Type" },
    { id: "resource", label: "Resource" },
    { id: "resourceType", label: "Resource Type" },
    { id: "resourceId", label: "Resource ID" },
    { id: "status", label: "Status" },
    { id: "severity", label: "Severity" },
    { id: "details", label: "Details" },
    { id: "ipAddress", label: "IP Address" },
    { id: "correlationId", label: "Correlation ID" },
    { id: "executionId", label: "Execution ID" },
    { id: "region", label: "Region" },
    { id: "accountId", label: "Account ID" },
    { id: "source", label: "Source" },
  ];

  const handleFieldToggle = (fieldId: string) => {
    setSelectedFields((prev) =>
      prev.includes(fieldId)
        ? prev.filter((id) => id !== fieldId)
        : [...prev, fieldId]
    );
  };

  const exportToCSV = () => {
    if (!logs || logs.length === 0) {
      alert("No data to export");
      return;
    }

    const headers = selectedFields.join(",");
    const rows = logs.map((log) => {
      return selectedFields
        .map((field) => {
          let value = log[field as keyof AuditLog];

          // Handle metadata field
          if (field === "metadata" && includeMetadata && log.metadata) {
            value = JSON.stringify(log.metadata);
          }

          // Escape CSV values
          if (
            typeof value === "string" &&
            (value.includes(",") || value.includes('"') || value.includes("\n"))
          ) {
            value = `"${value.replace(/"/g, '""')}"`;
          }

          return value || "";
        })
        .join(",");
    });

    const csvContent = [headers, ...rows].join("\n");
    downloadFile(
      csvContent,
      `audit-logs-${new Date().toISOString().split("T")[0]}.csv`,
      "text/csv"
    );
  };

  const exportToJSON = () => {
    if (!logs || logs.length === 0) {
      alert("No data to export");
      return;
    }

    const exportData = logs.map((log) => {
      const filteredLog: any = {};
      selectedFields.forEach((field) => {
        if (field === "metadata" && includeMetadata) {
          filteredLog[field] = log.metadata;
        } else if (field !== "metadata") {
          filteredLog[field] = log[field as keyof AuditLog];
        }
      });
      return filteredLog;
    });

    const jsonContent = JSON.stringify(exportData, null, 2);
    downloadFile(
      jsonContent,
      `audit-logs-${new Date().toISOString().split("T")[0]}.json`,
      "application/json"
    );
  };

  const downloadFile = (
    content: string,
    filename: string,
    mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      if (exportFormat === "csv") {
        exportToCSV();
      } else {
        exportToJSON();
      }
      onOpenChange(false);
    } catch (error) {
      console.error("Export error:", error);
      alert("Failed to export data. Please try again.");
    } finally {
      setIsExporting(false);
    }
  };

  return (<Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-2xl max-h-[95vh] flex flex-col">
      <DialogHeader className="flex-shrink-0">
        <DialogTitle className="flex items-center space-x-2">
          <Download className="h-5 w-5" />
          <span>Export Audit Logs</span>
        </DialogTitle>
        <DialogDescription>
          Export {logs.length} audit log entries to your preferred format
        </DialogDescription>
      </DialogHeader>

      <div className="flex-1 overflow-y-auto space-y-6 pr-2">
        {/* Export Format */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Export Format</CardTitle>
            <CardDescription>
              Choose the format for your exported data
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select
              value={exportFormat}
              onValueChange={(value: "csv" | "json") =>
                setExportFormat(value)
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">
                  <div className="flex items-center space-x-2">
                    <Table2 className="h-4 w-4" />
                    <span>CSV (Comma Separated Values)</span>
                  </div>
                </SelectItem>
                <SelectItem value="json">
                  <div className="flex items-center space-x-2">
                    <FileText className="h-4 w-4" />
                    <span>JSON (JavaScript Object Notation)</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Field Selection */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fields to Include</CardTitle>
            <CardDescription>
              Select which fields to include in the export
            </CardDescription>            </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 max-h-40 overflow-y-auto">
              {availableFields.map((field) => (
                <div key={field.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={field.id}
                    checked={selectedFields.includes(field.id)}
                    onCheckedChange={() => handleFieldToggle(field.id)}
                  />
                  <Label htmlFor={field.id} className="text-sm">
                    {field.label}
                  </Label>
                </div>
              ))}
            </div>

            <div className="mt-4 pt-4 border-t">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="includeMetadata"
                  checked={includeMetadata}
                  onCheckedChange={(checked) => setIncludeMetadata(!!checked)}
                />
                <Label htmlFor="includeMetadata" className="text-sm">
                  Include metadata (additional event data)
                </Label>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Export Summary */}
        <div className="bg-muted p-4 rounded-lg">
          <div className="text-sm space-y-1">
            <div>
              <strong>Records to export:</strong> {logs.length}
            </div>
            <div>
              <strong>Fields selected:</strong> {selectedFields.length}
            </div>
            <div>
              <strong>Format:</strong> {exportFormat.toUpperCase()}
            </div>
            <div>
              <strong>Include metadata:</strong>{" "}
              {includeMetadata ? "Yes" : "No"}
            </div>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex-shrink-0 flex justify-end space-x-2 pt-4 border-t">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          onClick={handleExport}
          disabled={
            isExporting || selectedFields.length === 0 || logs.length === 0
          }
        >
          {isExporting ? "Exporting..." : "Export Data"}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
  );
}

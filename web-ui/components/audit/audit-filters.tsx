"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  XCircle,
  Monitor,
  Zap,
  Server,
  Globe,
} from "lucide-react";

interface AuditFiltersProps {
  onFiltersChange?: (filters: any) => void;
}

export function AuditFilters({ onFiltersChange }: AuditFiltersProps) {
  const [correlationId, setCorrelationId] = useState("");
  const [executionId, setExecutionId] = useState("");
  const [ipAddress, setIpAddress] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [selectedSeverity, setSelectedSeverity] = useState("all");
  const [selectedSource, setSelectedSource] = useState("all");
  const [activeFilters, setActiveFilters] = useState<string[]>([]);

  const severityOptions = [
    { value: "all", label: "All Severities", icon: null },
    { value: "info", label: "Info", icon: <Activity className="h-4 w-4 text-info" /> },
    { value: "low", label: "Low", icon: <Activity className="h-4 w-4 text-success" /> },
    { value: "medium", label: "Medium", icon: <AlertTriangle className="h-4 w-4 text-warning" /> },
    { value: "high", label: "High", icon: <AlertTriangle className="h-4 w-4 text-warning" /> },
    { value: "critical", label: "Critical", icon: <XCircle className="h-4 w-4 text-destructive" /> },
  ];

  const sourceOptions = [
    { value: "all", label: "All Sources", icon: null },
    { value: "web-ui", label: "Web UI", icon: <Monitor className="h-4 w-4" /> },
    { value: "lambda", label: "Lambda Function", icon: <Zap className="h-4 w-4" /> },
    { value: "system", label: "System", icon: <Server className="h-4 w-4" /> },
    { value: "api", label: "API", icon: <Globe className="h-4 w-4" /> },
  ];

  // Derive active filters from current state — no stale closure risk
  const computeActiveFilters = (
    cId: string, eId: string, ip: string, rId: string, sev: string, src: string
  ) => {
    const active: string[] = [];
    if (cId) active.push("correlationId");
    if (eId) active.push("executionId");
    if (ip) active.push("ipAddress");
    if (rId) active.push("resourceId");
    if (sev !== "all") active.push("severity");
    if (src !== "all") active.push("source");
    return active;
  };

  const buildFilters = (
    cId: string, eId: string, ip: string, rId: string, sev: string, src: string
  ) => ({
    correlationId: cId || undefined,
    executionId: eId || undefined,
    ipAddress: ip || undefined,
    resourceId: rId || undefined,
    severity: sev !== "all" ? sev : undefined,
    source: src !== "all" ? src : undefined,
  });

  const applyFilters = () => {
    setActiveFilters(computeActiveFilters(correlationId, executionId, ipAddress, resourceId, selectedSeverity, selectedSource));
    onFiltersChange?.(buildFilters(correlationId, executionId, ipAddress, resourceId, selectedSeverity, selectedSource));
  };

  const clearAllFilters = () => {
    setCorrelationId("");
    setExecutionId("");
    setIpAddress("");
    setResourceId("");
    setSelectedSeverity("all");
    setSelectedSource("all");
    setActiveFilters([]);
    onFiltersChange?.({});
  };

  const removeFilter = (filterName: string) => {
    const next = {
      cId: filterName === "correlationId" ? "" : correlationId,
      eId: filterName === "executionId" ? "" : executionId,
      ip: filterName === "ipAddress" ? "" : ipAddress,
      rId: filterName === "resourceId" ? "" : resourceId,
      sev: filterName === "severity" ? "all" : selectedSeverity,
      src: filterName === "source" ? "all" : selectedSource,
    };
    if (filterName === "correlationId") setCorrelationId("");
    if (filterName === "executionId") setExecutionId("");
    if (filterName === "ipAddress") setIpAddress("");
    if (filterName === "resourceId") setResourceId("");
    if (filterName === "severity") setSelectedSeverity("all");
    if (filterName === "source") setSelectedSource("all");
    setActiveFilters(computeActiveFilters(next.cId, next.eId, next.ip, next.rId, next.sev, next.src));
    onFiltersChange?.(buildFilters(next.cId, next.eId, next.ip, next.rId, next.sev, next.src));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Advanced Filters</CardTitle>
        <CardDescription>
          Apply additional filters to narrow down the audit log results
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="correlationId">Correlation ID</Label>
            <Input
              id="correlationId"
              placeholder="Filter by correlation ID..."
              value={correlationId}
              onChange={(e) => setCorrelationId(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="executionId">Execution ID</Label>
            <Input
              id="executionId"
              placeholder="Filter by execution ID..."
              value={executionId}
              onChange={(e) => setExecutionId(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ipAddress">IP Address</Label>
            <Input
              id="ipAddress"
              placeholder="Filter by IP address..."
              value={ipAddress}
              onChange={(e) => setIpAddress(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="resourceId">Resource ID</Label>
            <Input
              id="resourceId"
              placeholder="Filter by resource ID..."
              value={resourceId}
              onChange={(e) => setResourceId(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Severity Level</Label>
            <Select value={selectedSeverity} onValueChange={setSelectedSeverity}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {severityOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <div className="flex items-center space-x-2">
                      {option.icon}
                      <span>{option.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Event Source</Label>
            <Select value={selectedSource} onValueChange={setSelectedSource}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sourceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <div className="flex items-center space-x-2">
                      {option.icon}
                      <span>{option.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {activeFilters.length > 0 && (
          <div className="space-y-2">
            <Label>Active Filters</Label>
            <div className="flex flex-wrap gap-2">
              {activeFilters.map((filter) => (
                <Badge key={filter} variant="secondary" className="flex items-center gap-1">
                  {filter}
                  <X className="h-3 w-3 cursor-pointer" onClick={() => removeFilter(filter)} />
                </Badge>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end space-x-2">
          <Button variant="outline" onClick={clearAllFilters}>
            Clear All
          </Button>
          <Button onClick={applyFilters}>Apply Filters</Button>
        </div>
      </CardContent>
    </Card>
  );
}

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
import { X, ChevronDown, ChevronUp } from "lucide-react";

interface AuditFiltersProps {
  onFiltersChange?: (filters: Record<string, string | undefined>) => void;
}

export function AuditFilters({ onFiltersChange }: AuditFiltersProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [correlationId, setCorrelationId] = useState("");
  const [executionId, setExecutionId] = useState("");
  const [ipAddress, setIpAddress] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [selectedSeverity, setSelectedSeverity] = useState("all");
  const [selectedSource, setSelectedSource] = useState("all");
  const [selectedResourceType, setSelectedResourceType] = useState("all");
  const [selectedUserType, setSelectedUserType] = useState("all");
  const [activeFilters, setActiveFilters] = useState<string[]>([]);

  // Dynamic filter values from DB
  const [filterOptions, setFilterOptions] = useState<{
    sources: string[];
    resourceTypes: string[];
    severities: string[];
    userTypes: string[];
  }>({ sources: [], resourceTypes: [], severities: [], userTypes: [] });

  useEffect(() => {
    fetch('/api/audit/filters')
      .then(res => res.json())
      .then(result => {
        if (result.success) {
          setFilterOptions({
            sources: result.data.sources || [],
            resourceTypes: result.data.resourceTypes || [],
            severities: result.data.severities || [],
            userTypes: result.data.userTypes || [],
          });
        }
      })
      .catch(() => {});
  }, []);

  const computeActiveFilters = (
    cId: string, eId: string, ip: string, rId: string, sev: string, src: string, rt: string, ut: string
  ) => {
    const active: string[] = [];
    if (cId) active.push("correlationId");
    if (eId) active.push("executionId");
    if (ip) active.push("ipAddress");
    if (rId) active.push("resourceId");
    if (sev !== "all") active.push("severity");
    if (src !== "all") active.push("source");
    if (rt !== "all") active.push("resourceType");
    if (ut !== "all") active.push("userType");
    return active;
  };

  const buildFilters = (
    cId: string, eId: string, ip: string, rId: string, sev: string, src: string, rt: string, ut: string
  ) => ({
    correlationId: cId || undefined,
    executionId: eId || undefined,
    ipAddress: ip || undefined,
    resourceId: rId || undefined,
    severity: sev !== "all" ? sev : undefined,
    source: src !== "all" ? src : undefined,
    resourceType: rt !== "all" ? rt : undefined,
    userType: ut !== "all" ? ut : undefined,
  });

  const applyFilters = () => {
    setActiveFilters(computeActiveFilters(correlationId, executionId, ipAddress, resourceId, selectedSeverity, selectedSource, selectedResourceType, selectedUserType));
    onFiltersChange?.(buildFilters(correlationId, executionId, ipAddress, resourceId, selectedSeverity, selectedSource, selectedResourceType, selectedUserType));
  };

  const clearAllFilters = () => {
    setCorrelationId("");
    setExecutionId("");
    setIpAddress("");
    setResourceId("");
    setSelectedSeverity("all");
    setSelectedSource("all");
    setSelectedResourceType("all");
    setSelectedUserType("all");
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
      rt: filterName === "resourceType" ? "all" : selectedResourceType,
      ut: filterName === "userType" ? "all" : selectedUserType,
    };
    if (filterName === "correlationId") setCorrelationId("");
    if (filterName === "executionId") setExecutionId("");
    if (filterName === "ipAddress") setIpAddress("");
    if (filterName === "resourceId") setResourceId("");
    if (filterName === "severity") setSelectedSeverity("all");
    if (filterName === "source") setSelectedSource("all");
    if (filterName === "resourceType") setSelectedResourceType("all");
    if (filterName === "userType") setSelectedUserType("all");
    setActiveFilters(computeActiveFilters(next.cId, next.eId, next.ip, next.rId, next.sev, next.src, next.rt, next.ut));
    onFiltersChange?.(buildFilters(next.cId, next.eId, next.ip, next.rId, next.sev, next.src, next.rt, next.ut));
  };

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setIsExpanded((v) => !v)}
      >
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Advanced Filters</CardTitle>
            <CardDescription>
              Apply additional filters to narrow down the audit log results
            </CardDescription>
          </div>
          {isExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </CardHeader>
      {isExpanded && <CardContent className="space-y-4">
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
                <SelectItem value="all">All Severities</SelectItem>
                {filterOptions.severities.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
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
                <SelectItem value="all">All Sources</SelectItem>
                {filterOptions.sources.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Resource Type</Label>
            <Select value={selectedResourceType} onValueChange={setSelectedResourceType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Resource Types</SelectItem>
                {filterOptions.resourceTypes.map((rt) => (
                  <SelectItem key={rt} value={rt}>
                    {rt.charAt(0).toUpperCase() + rt.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>User Type</Label>
            <Select value={selectedUserType} onValueChange={setSelectedUserType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All User Types</SelectItem>
                {filterOptions.userTypes.map((ut) => (
                  <SelectItem key={ut} value={ut}>
                    {ut.charAt(0).toUpperCase() + ut.slice(1)}
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
      </CardContent>}
    </Card>
  );
}

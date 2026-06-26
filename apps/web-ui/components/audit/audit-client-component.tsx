"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePickerWithRange } from "@/components/ui/date-range-picker";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity,
  Download,
  RefreshCw,
  Search,
  AlertTriangle,
  CheckCircle,
  XCircle,
  User,
  Server,
  ChevronLeft,
  ChevronRight,
  Filter,
} from "lucide-react";
import { AuditLogsTable } from "@/components/audit/audit-logs-table";
import { AuditLogsChart } from "@/components/audit/audit-logs-chart";
import { AuditFilters } from "@/components/audit/audit-filters";
import { ExportAuditDialog } from "@/components/audit/export-audit-dialog";
import { AuditLogFilters } from "@/lib/client-audit-service-api";
import {
  useAuditLogs,
  useAuditLogStats,
  useAuditFilterOptions,
} from "@/lib/queries/audit";
import type { DateRange } from "react-day-picker";

interface AuditStats {
  totalLogs: number;
  errorCount: number;
  warningCount: number;
  successCount: number;
  byEventType?: Record<string, number>;
}

interface AuditClientProps {
  initialFilters?: {
    eventType?: string;
    status?: string;
    user?: string;
    startDate?: string;
    endDate?: string;
  };
}

export default function AuditClient({ initialFilters }: AuditClientProps) {
  // Filter state
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedEventType, setSelectedEventType] = useState<string>(initialFilters?.eventType || "all");
  const [selectedStatus, setSelectedStatus] = useState<string>(initialFilters?.status || "all");
  const [selectedUser, setSelectedUser] = useState<string>(initialFilters?.user || "all");
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    if (initialFilters?.startDate || initialFilters?.endDate) {
      return {
        from: initialFilters.startDate ? new Date(initialFilters.startDate) : undefined,
        to: initialFilters.endDate ? new Date(initialFilters.endDate) : undefined,
      };
    }
    return undefined;
  });
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [advancedFilters, setAdvancedFilters] = useState<Partial<AuditLogFilters>>({});

  // Pagination state (cursor/token based). pageToken = token for the current page.
  const [pageSize, setPageSize] = useState(20);
  const [pageToken, setPageToken] = useState<string | undefined>(undefined);
  const [pageHistory, setPageHistory] = useState<(string | undefined)[]>([]);

  // Build the effective filters for the logs query (also serves as the query key).
  const logFilters: AuditLogFilters = { limit: pageSize };
  if (selectedEventType !== "all") logFilters.eventType = selectedEventType;
  if (selectedStatus !== "all") logFilters.status = selectedStatus;
  if (selectedUser !== "all") logFilters.user = selectedUser;
  if (searchTerm) logFilters.searchTerm = searchTerm;
  if (dateRange?.from) {
    const start = new Date(dateRange.from);
    start.setHours(0, 0, 0, 0);
    logFilters.startDate = start.toISOString();
  }
  if (dateRange?.to) {
    const end = new Date(dateRange.to);
    end.setHours(23, 59, 59, 999);
    logFilters.endDate = end.toISOString();
  }
  // Merge advanced filters (correlationId, executionId, ipAddress, resourceId, severity, source)
  Object.assign(logFilters, advancedFilters);
  if (pageToken) logFilters.nextPageToken = pageToken;

  // Stats use only the date range so the dropdowns stay populated.
  const statsFilters: AuditLogFilters = {};
  if (logFilters.startDate) statsFilters.startDate = logFilters.startDate;
  if (logFilters.endDate) statsFilters.endDate = logFilters.endDate;

  const logsQuery = useAuditLogs(logFilters);
  const statsQuery = useAuditLogStats(statsFilters);
  const filterOptionsQuery = useAuditFilterOptions();
  const filterOptions = filterOptionsQuery.data ?? {
    sources: [], users: [], resourceTypes: [], eventTypes: [], severities: [], statuses: [], userTypes: [],
  };

  const auditLogs = logsQuery.data?.logs ?? [];
  const filteredLogs = auditLogs;
  const nextPageToken = logsQuery.data?.nextPageToken;
  const loading = logsQuery.isFetching;
  const error = logsQuery.error
    ? logsQuery.error instanceof Error
      ? logsQuery.error.message
      : "Failed to load audit data"
    : null;

  const stats: AuditStats = {
    totalLogs: statsQuery.data?.totalLogs || 0,
    errorCount: statsQuery.data?.errorCount || 0,
    warningCount: statsQuery.data?.warningCount || 0,
    successCount: statsQuery.data?.successCount || 0,
    byEventType: statsQuery.data?.byEventType || {},
  };

  // Keep the URL in sync with the active filters.
  useEffect(() => {
    const urlParams = new URLSearchParams();
    if (logFilters.eventType) urlParams.set("eventType", logFilters.eventType);
    if (logFilters.status) urlParams.set("status", logFilters.status);
    if (logFilters.user) urlParams.set("user", logFilters.user);
    if (logFilters.startDate) urlParams.set("startDate", logFilters.startDate);
    if (logFilters.endDate) urlParams.set("endDate", logFilters.endDate);
    window.history.replaceState({}, "", `${window.location.pathname}${urlParams.toString() ? "?" + urlParams.toString() : ""}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventType, selectedStatus, selectedUser, dateRange]);

  // Reset pagination whenever the (non-token) filters change.
  useEffect(() => {
    setPageHistory([]);
    setPageToken(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventType, selectedStatus, selectedUser, searchTerm, dateRange, pageSize, advancedFilters]);

  const handleNextPage = () => {
    if (!nextPageToken || loading) return;
    setPageHistory((prev) => [...prev, pageToken]);
    setPageToken(nextPageToken);
  };

  const handlePrevPage = () => {
    if (pageHistory.length === 0 || loading) return;
    const newHistory = [...pageHistory];
    const prevToken = newHistory.pop();
    setPageHistory(newHistory);
    setPageToken(prevToken);
  };

  const handleRefresh = () => {
    setPageHistory([]);
    setPageToken(undefined);
    logsQuery.refetch();
    statsQuery.refetch();
  };

  const clearFilters = () => {
    setSearchTerm("");
    setSelectedEventType("all");
    setSelectedStatus("all");
    setSelectedUser("all");
    setAdvancedFilters({});
    setDateRange(undefined);
  };

  // Event types from dynamic filter options (DB-driven)
  const uniqueEventTypes = filterOptions.eventTypes
    .slice()
    .sort()
    .map((eventType) => ({
      value: eventType,
      label: eventType
        .split(".")
        .map((p) => p.replace(/_/g, " "))
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" → "),
    }));

  const getEventTypeLabel = (value: string) => {
    if (value === "all") return "All Events";
    return uniqueEventTypes.find((t) => t.value === value)?.label || value;
  };

  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Audit Logs</h1>
            <p className="text-muted-foreground">Monitor and track all system activities and events</p>
          </div>
        </div>
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <AlertTriangle className="h-8 w-8 text-destructive mx-auto mb-4" />
            <p className="text-destructive font-medium">{error}</p>
            <Button onClick={handleRefresh} className="mt-4">
              <RefreshCw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between sticky top-0 z-10 bg-background p-4 border-b">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Audit Logs</h1>
          <p className="text-muted-foreground">Monitor and track all system activities and events</p>
        </div>
        <div className="flex items-center space-x-2">
          <Button variant="outline" onClick={handleRefresh} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button onClick={() => setExportDialogOpen(true)}>
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Events</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalLogs}</div>
            <p className="text-xs text-muted-foreground">audit log entries</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Successful Events</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-success dark:text-success">{stats.successCount}</div>
            <p className="text-xs text-muted-foreground">completed successfully</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Warning Events</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-warning dark:text-warning">{stats.warningCount}</div>
            <p className="text-xs text-muted-foreground">completed with warnings</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Error Events</CardTitle>
            <XCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive dark:text-destructive">{stats.errorCount}</div>
            <p className="text-xs text-muted-foreground">failed or encountered errors</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Filters &amp; Search</CardTitle>
              <CardDescription>Filter and search through audit log entries</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search logs by user, action, resource, or details..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8"
              />
            </div>
            <DatePickerWithRange date={dateRange} onDateChange={setDateRange} className="w-[300px]" />
          </div>

          <div className="flex flex-wrap gap-2">
            <Select value={selectedEventType} onValueChange={setSelectedEventType}>
              <SelectTrigger className="w-[280px]">
                <SelectValue>{getEventTypeLabel(selectedEventType)}</SelectValue>
              </SelectTrigger>
              <SelectContent className="max-w-[400px]">
                <SelectItem value="all">All Events</SelectItem>
                {uniqueEventTypes.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    <div className="flex items-center space-x-2 max-w-[350px]">
                      <Activity className="h-4 w-4 flex-shrink-0" />
                      <span className="truncate">{type.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedStatus} onValueChange={setSelectedStatus}>
              <SelectTrigger className="w-[150px]">
                <SelectValue>
                  {selectedStatus === "all" ? "All Statuses" : selectedStatus.charAt(0).toUpperCase() + selectedStatus.slice(1)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {filterOptions.statuses.map((s) => (
                  <SelectItem key={s} value={s}>
                    <div className="flex items-center space-x-2">
                      {s === "success" && <CheckCircle className="h-4 w-4 text-success" />}
                      {s === "error" && <XCircle className="h-4 w-4 text-destructive" />}
                      {s === "warning" && <AlertTriangle className="h-4 w-4 text-warning" />}
                      {s === "info" && <Activity className="h-4 w-4 text-info" />}
                      <span>{s.charAt(0).toUpperCase() + s.slice(1)}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedUser} onValueChange={setSelectedUser}>
              <SelectTrigger className="w-[200px]">
                <SelectValue>{selectedUser === "all" ? "All Users" : selectedUser}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Users</SelectItem>
                {filterOptions.users.map((user) => (
                  <SelectItem key={user} value={user}>
                    <div className="flex items-center space-x-2">
                      {user === "system" ? <Server className="h-4 w-4" /> : <User className="h-4 w-4" />}
                      <span>{user}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button variant="outline" onClick={clearFilters} disabled={loading}>
              Reset Filters
            </Button>
            <Button onClick={handleRefresh} disabled={loading}>
              <Filter className="mr-2 h-4 w-4" />
              Apply Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Advanced Filters */}
      <AuditFilters onFiltersChange={setAdvancedFilters} />

      {/* Main Content */}
      <Tabs defaultValue="table" className="space-y-4">
        <TabsList>
          <TabsTrigger value="table">Table View</TabsTrigger>
          <TabsTrigger value="chart">Chart View</TabsTrigger>
        </TabsList>

        <TabsContent value="table" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Audit Log Entries</CardTitle>
              <CardDescription>
                {loading ? "Loading..." : `${filteredLogs.length} entries on this page`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center h-32">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                </div>
              ) : (
                <AuditLogsTable
                  logs={filteredLogs}
                  onFilter={(f) => {
                    if (f.correlationId) setAdvancedFilters((prev) => ({ ...prev, correlationId: f.correlationId }));
                  }}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="chart" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Audit Log Analytics</CardTitle>
              <CardDescription>Visual representation of audit log trends and patterns</CardDescription>
            </CardHeader>
            <CardContent>
              <AuditLogsChart logs={filteredLogs} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Pagination Controls */}
      <div className="flex items-center justify-between py-4">
        <div className="flex items-center space-x-2">
          <span className="text-sm text-muted-foreground">Rows per page</span>
          <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); }}>
            <SelectTrigger className="w-[80px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 50, 100].map((n) => (
                <SelectItem key={n} value={String(n)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrevPage}
            disabled={pageHistory.length === 0 || loading}
          >
            <ChevronLeft className="h-4 w-4 mr-2" />
            Previous
          </Button>
          <div className="text-sm font-medium">Page {pageHistory.length + 1}</div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNextPage}
            disabled={!nextPageToken || loading}
          >
            Next
            <ChevronRight className="h-4 w-4 ml-2" />
          </Button>
        </div>
      </div>

      <ExportAuditDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        logs={filteredLogs}
      />
    </div>
  );
}

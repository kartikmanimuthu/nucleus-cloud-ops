"use client";

import { useState, useEffect, useCallback } from "react";
import { useIsFirstRender } from "@/hooks/use-first-render";
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
  Filter,
  Search,
  AlertTriangle,
  CheckCircle,
  XCircle,
  User,
  Server,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { AuditLogsTable } from "@/components/audit/audit-logs-table";
import { AuditLogsChart } from "@/components/audit/audit-logs-chart";
import { ExportAuditDialog } from "@/components/audit/export-audit-dialog";
import { AuditFilters } from "@/components/audit/audit-filters";
import { addDays } from "date-fns";
import { AuditLog } from "@/lib/types";
import { AuditLogFilters, ClientAuditService } from "@/lib/client-audit-service-api";
import type { DateRange } from "react-day-picker";

interface AuditStats {
  totalLogs: number;
  errorCount: number;
  warningCount: number;
  successCount: number;
}

interface AuditClientProps {
  logsResponse: AuditLog[];
  statsResponse: AuditStats;
  mappedStats: AuditStats;
  initialFilters?: {
    eventType?: string;
    status?: string;
    user?: string;
    startDate?: string;
    endDate?: string;
  };
}

/**
 * Client component that handles UI interactivity for the audit page
 * Receives initial data from server component
 */
export default function AuditClient({
  logsResponse,
  statsResponse,
  mappedStats,
  initialFilters,
}: AuditClientProps) {
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>(logsResponse);
  const [filteredLogs, setFilteredLogs] = useState<AuditLog[]>(logsResponse);
  const [stats, setStats] = useState<AuditStats>(mappedStats);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Initialize states from URL parameters if available
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedEventType, setSelectedEventType] = useState<string>(initialFilters?.eventType || "all");
  const [selectedStatus, setSelectedStatus] = useState<string>(initialFilters?.status || "all");
  const [selectedUser, setSelectedUser] = useState<string>(initialFilters?.user || "all");
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    // Parse date strings if provided in initialFilters
    if (initialFilters?.startDate || initialFilters?.endDate) {
      return {
        from: initialFilters.startDate ? new Date(initialFilters.startDate) : addDays(new Date(), -7),
        to: initialFilters.endDate ? new Date(initialFilters.endDate) : new Date(),
      };
    }
    return {
      from: addDays(new Date(), -7),
      to: new Date(),
    };
  });
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  
  // Pagination State
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [currentToken, setCurrentToken] = useState<string | undefined>(undefined);
  const [pageHistory, setPageHistory] = useState<string[]>([]);
  const [advancedFilters, setAdvancedFilters] = useState<any>({});

  
  // Debounced search term setter
  // const debouncedSetSearchTerm = useDebouncedCallback((value: string) => {
  //   setSearchTerm(value);
  // }, 1000);

  // Update URL with current filters
  const updateUrlWithFilters = useCallback(() => {
    const params = new URLSearchParams();
    if (selectedEventType !== "all") params.set('eventType', selectedEventType);
    if (selectedStatus !== "all") params.set('status', selectedStatus);
    if (selectedUser !== "all") params.set('user', selectedUser);
    if (dateRange?.from) params.set('startDate', dateRange.from.toISOString());
    if (dateRange?.to) params.set('endDate', dateRange.to.toISOString());
    
    // Replace the current URL with the new one including filters
    const newUrl = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}`;
    window.history.replaceState({}, '', newUrl);
  }, [selectedEventType, selectedStatus, selectedUser, dateRange]);

  // Fetch audit logs and stats
  const fetchAuditData = useCallback(async (pageToken?: string) => {
    try {
      setLoading(true);
      setError(null);

      // Update URL first
      updateUrlWithFilters();

      // Build filters
      const filters: AuditLogFilters = {
        ...advancedFilters // Merge advanced filters
      };
      
      if (selectedEventType !== "all") filters.eventType = selectedEventType;
      if (selectedStatus !== "all") filters.status = selectedStatus;
      if (selectedUser !== "all") filters.user = selectedUser;
      if (dateRange?.from) filters.startDate = dateRange.from.toISOString();
      if (dateRange?.to) filters.endDate = dateRange.to.toISOString();
      
      if (pageToken) {
        filters.nextPageToken = pageToken;
      }

      // Fetch logs and stats in parallel
      const [logsResponse, stats] = await Promise.all([
        ClientAuditService.getAuditLogs(filters),
        ClientAuditService.getAuditLogStats(filters),
      ]);

      setAuditLogs(logsResponse.logs);
      setFilteredLogs(logsResponse.logs);
      setNextPageToken(logsResponse.nextPageToken);
      
      setStats({
        totalLogs: stats.totalLogs || 0,
        errorCount: stats.errorCount || 0,
        warningCount: stats.warningCount || 0,
        successCount: stats.successCount || 0,
      });
    } catch (err) {
      console.error("Error fetching audit data:", err);
      setError(err instanceof Error ? err.message : "Failed to load audit data");
    } finally {
      setLoading(false);
    }
  }, [selectedEventType, selectedStatus, selectedUser, dateRange, updateUrlWithFilters, advancedFilters]);

  // Track if this is the first render
  const isFirstRender = useIsFirstRender();

  // Update URL when filters change
  useEffect(() => {
    // Build URL with current filters
    const url = new URL(window.location.href);
    
    // Update or remove search params based on filter values
    if (selectedEventType !== 'all') {
      url.searchParams.set('eventType', selectedEventType);
    } else {
      url.searchParams.delete('eventType');
    }
    
    if (selectedStatus !== 'all') {
      url.searchParams.set('status', selectedStatus);
    } else {
      url.searchParams.delete('status');
    }
    
    if (selectedUser !== 'all') {
      url.searchParams.set('user', selectedUser);
    } else {
      url.searchParams.delete('user');
    }
    
    if (dateRange?.from) {
      url.searchParams.set('startDate', dateRange.from.toISOString());
    } else {
      url.searchParams.delete('startDate');
    }
    
    if (dateRange?.to) {
      url.searchParams.set('endDate', dateRange.to.toISOString());
    } else {
      url.searchParams.delete('endDate');
    }
    
    // Update URL without page reload
    window.history.pushState({}, '', url.toString());
    
    // Fetch fresh data when filters change (skip on initial render)
    if (!isFirstRender) {
      setPageHistory([]); // Reset history on filter change
      setNextPageToken(undefined);
      setCurrentToken(undefined);
      fetchAuditData();
    }
  }, [selectedEventType, selectedStatus, selectedUser, dateRange, advancedFilters, fetchAuditData, isFirstRender]);
  
  // Filter logs based on search term (client-side for performance)
  useEffect(() => {
    let filtered = auditLogs;

    if (searchTerm) {
      const lowercaseSearch = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (log) =>
          log.action.toLowerCase().includes(lowercaseSearch) ||
          log.user.toLowerCase().includes(lowercaseSearch) ||
          log.resource.toLowerCase().includes(lowercaseSearch) ||
          log.details.toLowerCase().includes(lowercaseSearch)
      );
    }

    setFilteredLogs(filtered);
  }, [auditLogs, searchTerm]);



  const handleRefresh = () => {
    setPageHistory([]);
    setNextPageToken(undefined);
    setCurrentToken(undefined);
    fetchAuditData();
  };

  const clearFilters = () => {
    setSearchTerm("");
    setSelectedEventType("all");
    setSelectedStatus("all");
    setSelectedUser("all");
    setDateRange({
      from: addDays(new Date(), -7),
      to: new Date(),
    });
    setAdvancedFilters({}); // Clear advanced filters
    setAdvancedFilters({}); // Clear advanced filters
    setPageHistory([]);
    setNextPageToken(undefined);
    setCurrentToken(undefined);
  };

  const handleDateRangeChange = (range: DateRange | undefined) => {
    setDateRange(range);
  };

  // Get unique values for filter dropdowns with proper formatting
  const uniqueEventTypes = Array.from(
    new Set(auditLogs.map((log) => log.eventType))
  ).map((eventType) => ({
    value: eventType,
    label: eventType
      .split(".")
      .map((part) => part.replace(/_/g, " "))
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" → "),
  }));

  const uniqueUsers = Array.from(new Set(auditLogs.map((log) => log.user)));

  // Helper function to get the display label for selected event type
  const getEventTypeLabel = (value: string) => {
    if (value === "all") return "All Events";
    const eventType = uniqueEventTypes.find((type) => type.value === value);
    return eventType ? eventType.label : value;
  };

  // Helper function to get the display label for selected status
  const getStatusLabel = (value: string) => {
    if (value === "all") return "All Statuses";
    return value.charAt(0).toUpperCase() + value.slice(1);
  };

  // Helper function to get the display label for selected user
  const getUserLabel = (value: string) => {
    if (value === "all") return "All Users";
    return value;
  };

  const handleAdvancedFiltersChange = (filters: any) => {
    console.log("Advanced filters changed:", filters);
    setAdvancedFilters(filters);
    // Effects will trigger fetch
  };

  const handleNextPage = () => {
    if (nextPageToken) {
       // Save current start token to history
       setPageHistory([...pageHistory, currentToken as string]); 
       setCurrentToken(nextPageToken);
       fetchAuditData(nextPageToken);
    }
  };

  const handlePrevPage = () => {
    if (pageHistory.length > 0) {
      const newHistory = [...pageHistory];
      const prevToken = newHistory.pop();
      setPageHistory(newHistory);
      setCurrentToken(prevToken);
      fetchAuditData(prevToken);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Audit Logs</h1>
            <p className="text-muted-foreground">
              Monitor and track all system activities and events
            </p>
          </div>
        </div>
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading audit data...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Audit Logs</h1>
            <p className="text-muted-foreground">
              Monitor and track all system activities and events
            </p>
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
          <p className="text-muted-foreground">
            Monitor and track all system activities and events
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Button variant="outline" onClick={handleRefresh} disabled={loading}>
            <RefreshCw
              className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
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
            <CardTitle className="text-sm font-medium">
              Successful Events
            </CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-success dark:text-success">
              {stats.successCount}
            </div>
            <p className="text-xs text-muted-foreground">
              completed successfully
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Warning Events
            </CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-warning dark:text-warning">
              {stats.warningCount}
            </div>
            <p className="text-xs text-muted-foreground">
              completed with warnings
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Error Events</CardTitle>
            <XCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive dark:text-destructive">
              {stats.errorCount}
            </div>
            <p className="text-xs text-muted-foreground">
              failed or encountered errors
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Filters & Search</CardTitle>
              <CardDescription>
                Filter and search through audit log entries
              </CardDescription>
            </div>
            <div className="flex items-center space-x-2">
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear All
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
              >
                <Filter className="mr-2 h-4 w-4" />
                {showAdvancedFilters ? "Hide" : "Show"} Advanced
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Basic Filters */}
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
            <DatePickerWithRange
              date={dateRange}
              onDateChange={handleDateRangeChange}
              className="w-[300px]"
            />
          </div>

          {/* Quick Filters */}
          <div className="flex flex-wrap gap-2">
            <Select
              value={selectedEventType}
              onValueChange={(value) => {
                console.log("Event type selected:", value);
                setSelectedEventType(value);
              }}
            >
              <SelectTrigger className="w-[280px]">
                <SelectValue>
                  {getEventTypeLabel(selectedEventType)}
                </SelectValue>
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

            <Select
              value={selectedStatus}
              onValueChange={(value) => {
                console.log("Status selected:", value);
                setSelectedStatus(value);
              }}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue>{getStatusLabel(selectedStatus)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="success">
                  <div className="flex items-center space-x-2">
                    <CheckCircle className="h-4 w-4 text-success" />
                    <span>Success</span>
                  </div>
                </SelectItem>
                <SelectItem value="error">
                  <div className="flex items-center space-x-2">
                    <XCircle className="h-4 w-4 text-destructive" />
                    <span>Error</span>
                  </div>
                </SelectItem>
                <SelectItem value="warning">
                  <div className="flex items-center space-x-2">
                    <AlertTriangle className="h-4 w-4 text-warning" />
                    <span>Warning</span>
                  </div>
                </SelectItem>
                <SelectItem value="info">
                  <div className="flex items-center space-x-2">
                    <Activity className="h-4 w-4 text-info" />
                    <span>Info</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={selectedUser}
              onValueChange={(value) => {
                console.log("User selected:", value);
                setSelectedUser(value);
              }}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue>{getUserLabel(selectedUser)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Users</SelectItem>
                {uniqueUsers.map((user) => (
                  <SelectItem key={user} value={user}>
                    <div className="flex items-center space-x-2">
                      {user === "system" ? (
                        <Server className="h-4 w-4" />
                      ) : (
                        <User className="h-4 w-4" />
                      )}
                      <span>{user}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Advanced Filters */}
          {showAdvancedFilters && (
              <AuditFilters onFiltersChange={handleAdvancedFiltersChange} />
          )}
        </CardContent>
      </Card>

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
                {filteredLogs.length} of {auditLogs.length} total entries
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AuditLogsTable logs={filteredLogs} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="chart" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Audit Log Analytics</CardTitle>
              <CardDescription>
                Visual representation of audit log trends and patterns
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AuditLogsChart logs={filteredLogs} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      
        {/* Pagination Controls */}
      {/* Pagination Controls */}
      <div className="flex items-center justify-end space-x-2 py-4">
        <Button
          variant="outline"
          size="sm"
          onClick={handlePrevPage}
          disabled={pageHistory.length === 0 || loading}
        >
          <ChevronLeft className="h-4 w-4 mr-2" />
          Previous
        </Button>
        <div className="text-sm font-medium">
            Page {pageHistory.length + 1}
        </div>
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

      {/* Export Dialog */}
      <ExportAuditDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        logs={filteredLogs}
      />
    </div>
  );
}

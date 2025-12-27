"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DatePickerWithRange } from "@/components/ui/date-range-picker";
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
  Loader2,
} from "lucide-react";
import { AuditLogsTable } from "@/components/audit/audit-logs-table";
import { AuditLogsChart } from "@/components/audit/audit-logs-chart";
import { ExportAuditDialog } from "@/components/audit/export-audit-dialog";
import { AuditFilters } from "@/components/audit/audit-filters";
import { addDays } from "date-fns";
import { AuditLog } from "@/lib/types";
import { ClientAuditService, AuditLogFilters } from "@/lib/client-audit-service-api";
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
 * Uses API-based client service for client-side filtering
 * Receives initial data from server component
 */
export default function AuditClientAPI({
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
    // Default to last 7 days
    return {
      from: addDays(new Date(), -7),
      to: new Date(),
    };
  });

  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const router = useRouter();

  // Get unique users from logs for the user filter dropdown
  const uniqueUsers = Array.from(
    new Set(auditLogs.map((log) => log.user).filter((user) => user !== undefined))
  );

  // Get unique event types from logs for the event type filter dropdown
  const uniqueEventTypes = Array.from(
    new Set(auditLogs.map((log) => log.action).filter((action) => action !== undefined))
  );

  // Fetch audit logs and stats
  const fetchAuditData = async (loadMore = false) => {
    try {
      setLoading(true);
      setError(null);

      // Build filters
      const filters: AuditLogFilters = {};
      if (selectedEventType !== "all") filters.eventType = selectedEventType;
      if (selectedStatus !== "all") filters.status = selectedStatus;
      if (selectedUser !== "all") filters.user = selectedUser;
      if (dateRange?.from) filters.startDate = dateRange.from.toISOString();
      if (dateRange?.to) filters.endDate = dateRange.to.toISOString();
      if (searchTerm) filters.searchTerm = searchTerm;

      // Logic for pagination
      if (loadMore && nextPageToken) {
          filters.nextPageToken = nextPageToken;
      }

      // Fetch logs and stats in parallel (only fetch stats on initial load to save resources)
      const promises: [Promise<any>, Promise<any>?] = [
        ClientAuditService.getAuditLogs(filters),
      ];
      
      if (!loadMore) {
          promises.push(ClientAuditService.getAuditLogStats(filters));
      }

      const [logsResponse, statsResponse] = await Promise.all(promises);

      if (loadMore) {
          setAuditLogs(prev => [...prev, ...logsResponse.logs]);
          setNextPageToken(logsResponse.nextPageToken);
      } else {
          setAuditLogs(logsResponse.logs);
          setNextPageToken(logsResponse.nextPageToken);
          if (statsResponse) {
              setStats({
                totalLogs: statsResponse.totalLogs,
                errorCount: statsResponse.errorCount,
                warningCount: statsResponse.warningCount,
                successCount: statsResponse.successCount,
              });
          }
      }

    } catch (err) {
      console.error("Error fetching audit data:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch audit data");
    } finally {
      setLoading(false);
    }
  };

  const loadMoreLogs = () => {
      if (!loading && nextPageToken) {
          fetchAuditData(true);
      }
  };

  // Handle refresh
  const handleRefresh = () => {
    fetchAuditData();
  };

  // Clear all filters
  const clearFilters = () => {
    setSelectedEventType("all");
    setSelectedStatus("all");
    setSelectedUser("all");
    setSearchTerm("");
    setDateRange({
      from: addDays(new Date(), -7),
      to: new Date(),
    });
    setShowAdvancedFilters(false);
  };

  // Handle date range change
  const handleDateRangeChange = (range: DateRange | undefined) => {
    console.log("Date range changed:", range);
    setDateRange(range);
  };

  // Apply search term filter to logs (for immediate feedback while waiting for API response)
  useEffect(() => {
    let result = auditLogs;
    
    // Apply search term filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (log) =>
          (log.action && log.action.toLowerCase().includes(term)) ||
          (log.resourceType && log.resourceType.toLowerCase().includes(term)) ||
          (log.user && log.user.toLowerCase().includes(term)) ||
          (log.details && log.details.toLowerCase().includes(term))
      );
    }
    
    // Sort by timestamp descending (most recent first)
    result = [...result].sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    
    setFilteredLogs(result);
  }, [searchTerm, auditLogs]);

  // Fetch data when any filter changes (all filters handled server-side)
  useEffect(() => {
    fetchAuditData();
  }, [selectedEventType, selectedStatus, selectedUser, dateRange, searchTerm]);

  // Helper function to get the display label for selected event type
  const getEventTypeLabel = (value: string) => {
    if (value === "all") return "All Events";
    return value;
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

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Logs</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalLogs}</div>
            <p className="text-xs text-muted-foreground">Audit log entries</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.successCount}</div>
            <p className="text-xs text-muted-foreground">Successful operations</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Warnings</CardTitle>
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.warningCount}</div>
            <p className="text-xs text-muted-foreground">Warning events</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Errors</CardTitle>
            <XCircle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.errorCount}</div>
            <p className="text-xs text-muted-foreground">Error events</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters Card */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <CardTitle>Filters</CardTitle>
              <CardDescription>
                Filter audit logs by various criteria
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={clearFilters}
              >
                <Filter className="mr-2 h-4 w-4" />
                Clear Filters
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setExportDialogOpen(true)}
              >
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Search and Date Range */}
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search logs by action, resource, user, or details..."
                className="pl-10"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="w-full md:w-auto">
              <DatePickerWithRange
                date={dateRange}
                onDateChange={handleDateRangeChange}
              />
            </div>
          </div>

          {/* Status and User Filters */}
          <div className="flex flex-col sm:flex-row gap-4">
            <Select
              value={selectedEventType}
              onValueChange={(value) => {
                console.log("Event type selected:", value);
                setSelectedEventType(value);
              }}
            >
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue>{getEventTypeLabel(selectedEventType)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Events</SelectItem>
                {uniqueEventTypes.map((eventType) => (
                  <SelectItem key={eventType} value={eventType}>
                    {eventType}
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
              <SelectTrigger className="w-full sm:w-[150px]">
                <SelectValue>{getStatusLabel(selectedStatus)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="success">
                  <div className="flex items-center space-x-2">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <span>Success</span>
                  </div>
                </SelectItem>
                <SelectItem value="error">
                  <div className="flex items-center space-x-2">
                    <XCircle className="h-4 w-4 text-red-500" />
                    <span>Error</span>
                  </div>
                </SelectItem>
                <SelectItem value="warning">
                  <div className="flex items-center space-x-2">
                    <AlertTriangle className="h-4 w-4 text-yellow-500" />
                    <span>Warning</span>
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
              <SelectTrigger className="w-full sm:w-[150px]">
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
          {showAdvancedFilters && <AuditFilters />}
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
                {filteredLogs.length} entries shown
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading && !nextPageToken ? (
                <div className="flex justify-center items-center h-32">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : error ? (
                <div className="text-center text-red-500 p-4">
                  Error: {error}
                </div>
              ) : (
                <>
                  <AuditLogsTable logs={filteredLogs} />
                  {nextPageToken && (
                      <div className="flex justify-center mt-4 p-4 border-t">
                          <Button 
                              variant="outline" 
                              onClick={loadMoreLogs}
                              disabled={loading}
                          >
                              {loading ? (
                                  <>
                                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                      Loading...
                                  </>
                              ) : (
                                  "Load More Logs"
                              )}
                          </Button>
                      </div>
                  )}
                </>
              )}
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
              {loading ? (
                <div className="flex justify-center items-center h-32">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : error ? (
                <div className="text-center text-red-500 p-4">
                  Error: {error}
                </div>
              ) : (
                <AuditLogsChart logs={filteredLogs} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Export Dialog */}
      <ExportAuditDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        logs={filteredLogs}
      />
    </div>
  );
}

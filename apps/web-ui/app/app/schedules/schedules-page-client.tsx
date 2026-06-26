"use client";

import { useState, useEffect, useCallback } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Filter, RefreshCw, AlertCircle, Calendar, Settings, Play, Pause, Zap } from "lucide-react";
import { SchedulesTable } from "@/components/schedules/schedules-table";
import { SchedulesGrid } from "@/components/schedules/schedules-grid";
import { ImportSchedulesDialog } from "@/components/schedules/import-schedules-dialog";
import { BulkActionBar } from "@/components/shared/bulk-action-bar";
import type { BulkAction, BulkActionResult } from "@/lib/bulk-actions/types";
import { UISchedule } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { useSchedules } from "@/lib/queries/schedules";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queries/query-keys";
import { PaginationBar } from "@/components/ui/pagination-bar";

const SCHEDULE_BULK_ACTIONS: BulkAction[] = [
  { key: "activate", label: "Activate", icon: Play },
  { key: "deactivate", label: "Deactivate", icon: Pause },
  { key: "execute", label: "Execute Now", icon: Zap },
];

const statusFilters = [
  { value: "all", label: "All Schedules" },
  { value: "active", label: "Active Only" },
  { value: "inactive", label: "Inactive Only" },
];

const resourceFilters = [
  { value: "all", label: "All Resources" },
  { value: "EC2", label: "EC2 Instances" },
  { value: "RDS", label: "RDS Databases" },
  { value: "ECS", label: "ECS Services" },
  { value: "ElastiCache", label: "ElastiCache" },
];

interface SchedulesPageClientProps {
  initialSchedules: UISchedule[];
  initialError?: string;
  stats?: {
    total: number;
    active: number;
    inactive: number;
    totalSavings: number;
  };
  initialFilters?: {
    statusFilter: string;
    resourceFilter: string;
    searchTerm: string;
  };
  initialPagination?: {
    page: number;
    limit: number;
    total: number;
  };
}

export function SchedulesPageClient({
  initialSchedules,
  initialError,
  stats,
  initialFilters,
  initialPagination,
}: SchedulesPageClientProps) {
  const router = useRouter();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Effective filters (drive data fetching)
  const [searchTerm, setSearchTerm] = useState(initialFilters?.searchTerm || "");
  const [statusFilter, setStatusFilter] = useState(initialFilters?.statusFilter || "all");
  const [resourceFilter, setResourceFilter] = useState(initialFilters?.resourceFilter || "all");

  // Pagination state
  const [currentPage, setCurrentPage] = useState(initialPagination?.page || 1);
  const [limit, setLimit] = useState(initialPagination?.limit || 10);

  // Local UI state for filters (pending application)
  const [localSearchTerm, setLocalSearchTerm] = useState(initialFilters?.searchTerm || "");
  const [localStatusFilter, setLocalStatusFilter] = useState(initialFilters?.statusFilter || "all");
  const [localResourceFilter, setLocalResourceFilter] = useState(initialFilters?.resourceFilter || "all");

  const [viewMode, setViewMode] = useState<"table" | "grid">("grid");
  const [selectedSchedules, setSelectedSchedules] = useState<string[]>([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  // Effective filters object — also serves as the query key.
  const filters = {
    statusFilter: statusFilter !== "all" ? statusFilter : undefined,
    resourceFilter: resourceFilter !== "all" ? resourceFilter : undefined,
    searchTerm: searchTerm || undefined,
    page: currentPage,
    limit,
  };

  // Seed first paint from server data (no flash) while filters match the server.
  const isInitialView =
    currentPage === (initialPagination?.page ?? 1) &&
    limit === (initialPagination?.limit ?? 10) &&
    searchTerm === (initialFilters?.searchTerm ?? "") &&
    statusFilter === (initialFilters?.statusFilter ?? "all") &&
    resourceFilter === (initialFilters?.resourceFilter ?? "all");

  // Main list query (TanStack Query — replaces manual fetch + useEffect).
  const schedulesQuery = useSchedules(
    filters,
    isInitialView
      ? {
          initialData: {
            schedules: initialSchedules,
            total: initialPagination?.total ?? initialSchedules.length,
          },
        }
      : undefined,
  );

  // Stats query — all schedules, unfiltered (separate cache entry).
  const statsQuery = useSchedules({ limit: 1000 });

  const schedules = schedulesQuery.data?.schedules ?? [];
  const totalItems = schedulesQuery.data?.total ?? initialPagination?.total ?? 0;
  const loading = schedulesQuery.isLoading;
  const isRefreshing = schedulesQuery.isFetching;
  const queryError = schedulesQuery.error
    ? schedulesQuery.error instanceof Error
      ? schedulesQuery.error.message
      : "Failed to load schedules"
    : null;
  const error = queryError ?? initialError ?? null;
  const allSchedules = statsQuery.data?.schedules ?? [];

  // Use schedules directly since filtering is done server-side.
  const filteredSchedules = schedules;

  // Keep the URL in sync with the effective filters/pagination.
  const updateUrlWithFilters = useCallback(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (resourceFilter !== "all") params.set("resource", resourceFilter);
    if (searchTerm) params.set("search", searchTerm);
    if (currentPage > 1) params.set("page", currentPage.toString());
    params.set("limit", limit.toString());
    const newUrl = `${window.location.pathname}${params.toString() ? "?" + params.toString() : ""}`;
    window.history.replaceState({}, "", newUrl);
  }, [statusFilter, resourceFilter, searchTerm, currentPage, limit]);

  useEffect(() => {
    updateUrlWithFilters();
  }, [updateUrlWithFilters]);

  // Invalidate schedule caches after a mutation (dialogs, bulk actions).
  const invalidateSchedules = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all });
  }, [queryClient]);

  const handleScheduleUpdated = (message?: string) => {
    invalidateSchedules();
    if (message) {
      toast({ variant: "success" as any, title: "Success", description: message });
    }
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedSchedules(filteredSchedules.map((s) => s.id));
    } else {
      setSelectedSchedules([]);
    }
  };

  const handleSelectSchedule = (scheduleId: string, checked: boolean) => {
    if (checked) {
      setSelectedSchedules([...selectedSchedules, scheduleId]);
    } else {
      setSelectedSchedules(selectedSchedules.filter((id) => id !== scheduleId));
    }
  };

  // Run a bulk action against the selected schedules, then report + refresh.
  const handleBulkAction = async (action: string) => {
    const scheduleIds = selectedSchedules;
    if (scheduleIds.length === 0) return;

    try {
      setBulkLoading(true);
      const res = await fetch("/api/schedules/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, scheduleIds }),
      });
      const payload = await res.json();

      if (!res.ok || !payload.success) {
        throw new Error(payload.error || "Bulk action failed");
      }

      const result = payload.data as BulkActionResult;
      const label =
        SCHEDULE_BULK_ACTIONS.find((a) => a.key === action)?.label || action;

      toast({
        variant: result.failed > 0 ? "destructive" : "success",
        title: `${label}: ${result.succeeded}/${result.total} succeeded`,
        description:
          result.failed > 0
            ? `${result.failed} failed. See console for details.`
            : `${label} completed on ${result.succeeded} schedule${result.succeeded !== 1 ? "s" : ""}.`,
      });

      setSelectedSchedules([]);
      invalidateSchedules();
    } catch (error) {
      console.error("Error running bulk schedule action:", error);
      toast({
        variant: "destructive",
        title: "Bulk Action Failed",
        description:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    } finally {
      setBulkLoading(false);
    }
  };

  const refreshSchedules = () => {
    invalidateSchedules();
  };

  const handleApplyFilter = () => {
    setSearchTerm(localSearchTerm);
    setStatusFilter(localStatusFilter);
    setResourceFilter(localResourceFilter);
    setCurrentPage(1); // Reset to first page
  };

  const handleClearFilter = () => {
    setLocalSearchTerm("");
    setLocalStatusFilter("all");
    setLocalResourceFilter("all");
    setSearchTerm("");
    setStatusFilter("all");
    setResourceFilter("all");
    setCurrentPage(1); // Reset to first page
  };

  const handleCreateSchedule = () => {
    router.push("/app/schedules/create");
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between sticky top-0 z-10 bg-background p-4 border-b">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Cost Scheduler</h1>
          <p className="text-muted-foreground">
            Manage cost optimization schedules and time configurations
          </p>
        </div>
        <div className="flex items-center justify-end space-x-2">
          <Button variant="outline" size="icon" onClick={() => router.push("/app/schedules/settings")} title="Scheduler Settings">
            <Settings className="h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={refreshSchedules}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={handleCreateSchedule}>
            <Plus className="mr-2 h-4 w-4" />
            Create Schedule
          </Button>
        </div>
      </div>



      {/* Calculated Summary Stats from Global Data */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Total Schedules
            </CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{allSchedules.length}</div>
            <p className="text-xs text-muted-foreground">
              {allSchedules.filter(s => s.active).length} active, {allSchedules.filter(s => !s.active).length} inactive
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Active Schedules
            </CardTitle>
            <div className="h-4 w-4 rounded-full bg-success/10 flex items-center justify-center">
              <div className="h-2 w-2 rounded-full bg-green-600"></div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{allSchedules.filter(s => s.active).length}</div>
            <p className="text-xs text-muted-foreground">
              {allSchedules.length > 0
                ? ((allSchedules.filter(s => s.active).length / allSchedules.length) * 100).toFixed(1)
                : 0}
              % success rate
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Monthly Savings
            </CardTitle>
            <span className="text-success dark:text-success">$</span>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${allSchedules.reduce((sum, s) => sum + (s.estimatedSavings || 0), 0).toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">
              across all schedules
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Filtered</CardTitle>
            <Filter className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalItems}</div>
            <p className="text-xs text-muted-foreground">
              schedules match filters
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Loading State */}
      {loading && (
        <Card>
          <CardContent className="flex items-center justify-center py-8">
            <div className="flex items-center space-x-2">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span>Loading schedules...</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Selected Schedules Summary */}
      {selectedSchedules.length > 0 && !loading && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Selected</CardTitle>
            <Filter className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {selectedSchedules.length}
            </div>
            <p className="text-xs text-muted-foreground">
              use the bulk action bar below
            </p>
          </CardContent>
        </Card>
      )}

      {/* Filters and Search - only show when not loading */}
      {!loading && (
        <Card>
          <CardHeader>
            <CardTitle>Filters</CardTitle>
            <CardDescription>
              Search and filter schedules to find what you need
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1">
                <Input
                  placeholder="Search schedules..."
                  value={localSearchTerm}
                  onChange={(e) => setLocalSearchTerm(e.target.value)}
                  className="w-full"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleApplyFilter();
                  }}
                />
              </div>
              <Select value={localStatusFilter} onValueChange={setLocalStatusFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  {statusFilters.map((filter) => (
                    <SelectItem key={filter.value} value={filter.value}>
                      {filter.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={localResourceFilter} onValueChange={setLocalResourceFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Filter by resource" />
                </SelectTrigger>
                <SelectContent>
                  {resourceFilters.map((filter) => (
                    <SelectItem key={filter.value} value={filter.value}>
                      {filter.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
               <Button variant="default" onClick={handleApplyFilter}>
                Apply Filter
              </Button>
              <Button variant="outline" onClick={handleClearFilter}>
                Clear Filters
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bulk action bar — appears when rows are selected */}
      {!loading && (
        <BulkActionBar
          count={selectedSchedules.length}
          actions={SCHEDULE_BULK_ACTIONS}
          onAction={handleBulkAction}
          onClear={() => setSelectedSchedules([])}
          isLoading={bulkLoading}
          itemNoun="schedule"
        />
      )}

      {/* View Toggle and Content - only show when not loading */}
      {!loading && (
        <Tabs
          value={viewMode}
          onValueChange={(value) => setViewMode(value as "table" | "grid")}
        >
          <TabsList>
            <TabsTrigger value="table">Table View</TabsTrigger>
            <TabsTrigger value="grid">Grid View</TabsTrigger>
          </TabsList>

          <TabsContent value="table" className="space-y-4">
            <SchedulesTable
              schedules={filteredSchedules}
              selectedSchedules={selectedSchedules}
              onSelectAll={handleSelectAll}
              onSelectSchedule={handleSelectSchedule}
              onScheduleUpdated={handleScheduleUpdated}
            />
          </TabsContent>

          <TabsContent value="grid" className="space-y-4">
            <SchedulesGrid
              schedules={filteredSchedules}
              selectedSchedules={selectedSchedules}
              onSelectSchedule={handleSelectSchedule}
              onScheduleUpdated={handleScheduleUpdated}
            />
          </TabsContent>
        </Tabs>
      )}

      {/* Pagination */}
      {!loading && (
        <PaginationBar
          currentPage={currentPage}
          totalItems={totalItems}
          pageSize={limit}
          onPageChange={setCurrentPage}
          onPageSizeChange={(size) => { setLimit(size); setCurrentPage(1); }}
          pageSizeOptions={[10, 25, 50, 100]}
          itemLabel="schedules"
        />
      )}

      {/* Dialogs */}
      <ImportSchedulesDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
      />
    </div>
  );
}

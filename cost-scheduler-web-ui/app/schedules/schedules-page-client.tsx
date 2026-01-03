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
import { Plus, Filter, RefreshCw, AlertCircle, Calendar, Settings } from "lucide-react";
import { SchedulesTable } from "@/components/schedules/schedules-table";
import { SchedulesGrid } from "@/components/schedules/schedules-grid";
import { BulkActionsDialog } from "@/components/schedules/bulk-actions-dialog";
import { ImportSchedulesDialog } from "@/components/schedules/import-schedules-dialog";
import { UISchedule } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { useIsFirstRender } from "@/hooks/use-first-render";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

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

  // Data state - start with server-side data
  const [schedules, setSchedules] = useState<UISchedule[]>(initialSchedules);
  const [error, setError] = useState<string | null>(initialError || null);
  const [loading, setLoading] = useState(false);
  const [totalItems, setTotalItems] = useState(initialPagination?.total || initialSchedules.length);

  // Effective filters (used for fetching data)
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

  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
  const [selectedSchedules, setSelectedSchedules] = useState<string[]>([]);
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  
  const { toast } = useToast();

  // Update URL with current filters and pagination
  const updateUrlWithFilters = useCallback(() => {
    const params = new URLSearchParams();
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (resourceFilter !== 'all') params.set('resource', resourceFilter);
    if (searchTerm) params.set('search', searchTerm);
    if (currentPage > 1) params.set('page', currentPage.toString());
    params.set('limit', limit.toString());
    
    // Replace the current URL with the new one including filters
    const newUrl = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}`;
    window.history.replaceState({}, '', newUrl);
  }, [statusFilter, resourceFilter, searchTerm, currentPage, limit]);

  // Load schedules with current filters
  const loadSchedulesWithFilters = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Update URL first
      updateUrlWithFilters();
      
      const filters = {
        statusFilter: statusFilter !== 'all' ? statusFilter : undefined,
        resourceFilter: resourceFilter !== 'all' ? resourceFilter : undefined,
        searchTerm: searchTerm || undefined,
        page: currentPage,
        limit: limit
      };
      const result = await ClientScheduleService.getSchedules(filters);
      setSchedules(result.schedules);
      setTotalItems(result.total);
    } catch (err) {
      console.error("Error loading schedules:", err);
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, resourceFilter, searchTerm, currentPage, limit, updateUrlWithFilters]);

  // Handle schedule updates - this will refresh schedules with current filters
  const handleScheduleUpdated = (message?: string) => {
    loadSchedulesWithFilters();
    if (message) {
      toast({
        variant: "success" as any,
        title: "Success",
        description: message,
      });
    }
  };

  // Track if this is the first render
  const isFirstRender = useIsFirstRender();

  // Update URL and fetch data when EFFECTIVE filters change
  useEffect(() => {
    // Only trigger if not first render, OR if we want to ensure client-side fetch sync
    if (!isFirstRender) {
      loadSchedulesWithFilters();
    }
  }, [searchTerm, statusFilter, resourceFilter, currentPage, limit, loadSchedulesWithFilters, isFirstRender]);

  // Use schedules directly since filtering is done server-side
  const filteredSchedules = schedules;

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

  // Sync state with props when server re-renders (e.g. after refresh)
  useEffect(() => {
    setSchedules(initialSchedules);
  }, [initialSchedules]);

  useEffect(() => {
    if (initialError) setError(initialError);
  }, [initialError]);

  const refreshSchedules = () => {
    // Reloads server data but maintains current client state filters?
    // User wants "Refresh" to refresh the full state of the page.
    // We'll re-fetch with current EFFECTIVE filters.
    // ClientScheduleService has 'no-store' so it will get fresh data.
    loadSchedulesWithFilters();
  };

  const handleApplyFilter = () => {
    setSearchTerm(localSearchTerm);
    setStatusFilter(localStatusFilter);
    setResourceFilter(localResourceFilter);
    setCurrentPage(1); // Reset to first page
  };

  const handleClearFilter = () => {
    // Reset local state
    setLocalSearchTerm("");
    setLocalStatusFilter("all");
    setLocalResourceFilter("all");
    
    // Reset effective state (triggers reload)
    setSearchTerm("");
    setStatusFilter("all");
    setResourceFilter("all");
    setCurrentPage(1); // Reset to first page
  };

  const handleCreateSchedule = () => {
    router.push("/schedules/create");
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between sticky top-0 z-10 bg-background p-4 border-b">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Schedules</h1>
          <p className="text-muted-foreground">
            Manage cost optimization schedules and time configurations
          </p>
        </div>
        <div className="flex items-center justify-end space-x-2">
          <Button variant="outline" size="icon" onClick={() => router.push("/schedules/settings")} title="Scheduler Settings">
            <Settings className="h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={refreshSchedules}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={handleCreateSchedule}>
            <Plus className="mr-2 h-4 w-4" />
            Create Schedule
          </Button>
        </div>
      </div>

      {/* Server-rendered Summary Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Total Schedules
            </CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.total}</div>
            <p className="text-xs text-muted-foreground">
              {stats?.active} active, {stats?.inactive} inactive
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
            <div className="text-2xl font-bold">{stats?.active || 0}</div>
            <p className="text-xs text-muted-foreground">
              {stats && stats.total > 0 && stats.active !== undefined
                ? ((stats.active / stats.total) * 100).toFixed(1)
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
              ${stats?.totalSavings?.toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">
              across all schedules
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Schedules</CardTitle>
            <Filter className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.total}</div>
            <p className="text-xs text-muted-foreground">
              server-side rendered
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
              <Button
                variant="link"
                size="sm"
                className="p-0 h-auto text-xs"
                onClick={() => setBulkActionsOpen(true)}
              >
                Bulk actions
              </Button>
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
      {!loading && totalItems > 0 && (
        <Pagination className="mt-4">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious 
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (currentPage > 1) setCurrentPage(currentPage - 1);
                }}
                aria-disabled={currentPage === 1}
                className={currentPage === 1 ? "pointer-events-none opacity-50" : ""}
              />
            </PaginationItem>
            
            {/* Simple pagination logic: just show current page context or ranges */}
            {/* For now, simplified view: Prev, Page X of Y, Next */}
            
            <PaginationItem>
              <span className="px-4 text-sm text-muted-foreground">
                Page {currentPage} of {Math.ceil(totalItems / limit)}
              </span>
            </PaginationItem>

            <PaginationItem>
              <PaginationNext 
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (currentPage < Math.ceil(totalItems / limit)) setCurrentPage(currentPage + 1);
                }}
                aria-disabled={currentPage >= Math.ceil(totalItems / limit)}
                className={currentPage >= Math.ceil(totalItems / limit) ? "pointer-events-none opacity-50" : ""}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}

      {/* Dialogs */}
      <BulkActionsDialog
        open={bulkActionsOpen}
        onOpenChange={setBulkActionsOpen}
        selectedSchedules={selectedSchedules}
        onClearSelection={() => setSelectedSchedules([])}
        onSchedulesUpdated={() =>
          handleScheduleUpdated("Schedules updated successfully!")
        }
      />
      <ImportSchedulesDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
      />
    </div>
  );
}

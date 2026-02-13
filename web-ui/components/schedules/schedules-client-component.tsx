"use client";

import { useState, useCallback, useEffect } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Calendar,
  Plus,
  Filter,
  RefreshCw,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { SchedulesTable } from "@/components/schedules/schedules-table";
import { SchedulesGrid } from "@/components/schedules/schedules-grid";
import { BulkActionsDialog } from "@/components/schedules/bulk-actions-dialog";
import { ImportSchedulesDialog } from "@/components/schedules/import-schedules-dialog";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { useToast } from "@/hooks/use-toast";
import { UISchedule } from "@/lib/types";

interface FilterOption {
  value: string;
  label: string;
}

interface SchedulesClientProps {
  initialSchedules: UISchedule[];
  statusFilters: FilterOption[];
  resourceFilters: FilterOption[];
    initialFilters?: {
    statusFilter: string;
    resourceFilter: string;
    searchTerm: string;
  };
}

/**
 * Client component that handles UI interactivity for the schedules page
 * Receives initial data from server component
 */
export default function SchedulesClient({
  initialSchedules,
  statusFilters,
  resourceFilters,
    initialFilters,
}: SchedulesClientProps) {
  const router = useRouter();

  // Data state
  const [schedules, setSchedules] = useState<UISchedule[]>(initialSchedules);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UI state
  // UI state
  const [searchTerm, setSearchTerm] = useState(initialFilters?.searchTerm || "");
  const [statusFilter, setStatusFilter] = useState(initialFilters?.statusFilter || "all");
  const [resourceFilter, setResourceFilter] = useState(initialFilters?.resourceFilter || "all");
  const [viewMode, setViewMode] = useState<"table" | "grid">("grid");
  const [selectedSchedules, setSelectedSchedules] = useState<string[]>([]);
  
  // Stats state
  const [allSchedules, setAllSchedules] = useState<UISchedule[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  const { toast } = useToast();

    // Load schedules with current filters
  const loadSchedulesWithFilters = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const filters = {
        statusFilter: statusFilter !== 'all' ? statusFilter : undefined,
        resourceFilter: resourceFilter !== 'all' ? resourceFilter : undefined,
        searchTerm: searchTerm || undefined,
      };
      
      const result = await ClientScheduleService.getSchedules(filters);
      setSchedules(result.schedules);
      
    } catch (err) {
      console.error("Error loading schedules:", err);
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, resourceFilter, searchTerm]);

  // Load global stats (all schedules)
  const loadStats = useCallback(async () => {
    try {
      setLoadingStats(true);
      // Fetch all schedules for stats (no limit)
      const result = await ClientScheduleService.getSchedules({ limit: 1000 });
      setAllSchedules(result.schedules);
    } catch (err) {
      console.error("Error loading stats:", err);
    } finally {
        setLoadingStats(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
     loadStats();
  }, [loadStats]);

  // Refresh schedules (load with current filters)
  const refreshSchedules = () => {
    loadSchedulesWithFilters();
  };

    // Handle clearing filters
    const clearFilters = () => {
        setSearchTerm("");
        setStatusFilter("all");
        setResourceFilter("all");
        // We need to call service without filters, but state updates are async.
        // So we call service directly with empty filters
        loadAllSchedules();
    };

    const loadAllSchedules = async () => {
        try {
            setLoading(true);
            setError(null);
            const result = await ClientScheduleService.getSchedules();
            setSchedules(result.schedules);
        } catch (err) {
            console.error("Error loading schedules:", err);
            setError(err instanceof Error ? err.message : "Failed to load schedules");
        } finally {
            setLoading(false);
        }
    }


  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedSchedules(schedules.map((s) => s.id));
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

  const handleCreateSchedule = () => {
    router.push("/schedules/create");
  };

  // Calculate summary statistics from ALL schedules, not just current page
  const stats = {
    total: allSchedules.length,
    active: allSchedules.filter((s) => s.active).length,
    inactive: allSchedules.filter((s) => !s.active).length,
    totalSavings: allSchedules.reduce(
      (sum, s) => sum + (s.estimatedSavings || 0),
      0
    ),
  };

  // Handle schedule updates - this will be called by child components
  const handleScheduleUpdated = (message?: string) => {
    loadSchedulesWithFilters();
    loadStats(); // Refresh stats too
    if (message) {
      toast({
        variant: "success",
        title: "Success",
        description: message,
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Cost Scheduler</h1>
          <p className="text-muted-foreground">
            Manage cost optimization schedules and time configurations
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            onClick={refreshSchedules}
            disabled={loading}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button onClick={handleCreateSchedule}>
            <Plus className="mr-2 h-4 w-4" />
            Create Schedule
          </Button>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error}
            <Button
              variant="link"
              onClick={refreshSchedules}
              className="ml-2 p-0 h-auto"
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Loading State */}
      {loading && !error && (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <div className="text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin" />
              <p className="mt-2 text-sm text-muted-foreground">
                Loading schedules...
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary Stats - only show when not loading */}
      {!loading && (
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Total Schedules
              </CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
              <p className="text-xs text-muted-foreground">
                {stats.active} active, {stats.inactive} inactive
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
              <div className="text-2xl font-bold">{stats.active}</div>
              <p className="text-xs text-muted-foreground">
                {stats.total > 0
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
                ${stats.totalSavings.toLocaleString()}
              </div>
              <p className="text-xs text-muted-foreground">
                across all schedules
              </p>
            </CardContent>
          </Card>

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
                {selectedSchedules.length > 0 && (
                  <Button
                    variant="link"
                    size="sm"
                    className="p-0 h-auto text-xs"
                    onClick={() => setBulkActionsOpen(true)}
                  >
                    Bulk actions
                  </Button>
                )}
              </p>
            </CardContent>
          </Card>
        </div>
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
                  placeholder="Search schedules by name, description, or creator..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
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
              <Select value={resourceFilter} onValueChange={setResourceFilter}>
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
              <Button
                variant="default"
                onClick={loadSchedulesWithFilters}
              >
                Apply Filters
              </Button>
              <Button
                variant="outline"
                onClick={clearFilters}
              >
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
              schedules={schedules}
              selectedSchedules={selectedSchedules}
              onSelectAll={handleSelectAll}
              onSelectSchedule={handleSelectSchedule}
              onScheduleUpdated={handleScheduleUpdated}
            />
          </TabsContent>

          <TabsContent value="grid" className="space-y-4">
            <SchedulesGrid
              schedules={schedules}
              selectedSchedules={selectedSchedules}
              onSelectSchedule={handleSelectSchedule}
              onScheduleUpdated={handleScheduleUpdated}
            />
          </TabsContent>
        </Tabs>
      )}

      {/* Dialogs */}
      <BulkActionsDialog
        open={bulkActionsOpen}
        onOpenChange={setBulkActionsOpen}
        selectedSchedules={selectedSchedules}
        onClearSelection={() => setSelectedSchedules([])}
        onSchedulesUpdated={() => handleScheduleUpdated("Bulk action completed successfully")}
      />
      <ImportSchedulesDialog
        open={importDialogOpen}
        onOpenChange={(open) => {
          setImportDialogOpen(open);
          // If dialog is closed, refresh schedules to show any imported ones
          if (!open) loadSchedulesWithFilters();
        }}
      />
    </div>
  );
}

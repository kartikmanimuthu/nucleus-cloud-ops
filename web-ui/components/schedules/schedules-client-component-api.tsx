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
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Calendar,
  Plus,
  Filter,
  RefreshCw,
  Loader2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
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

interface SchedulesClientAPIProps {
  initialSchedules: UISchedule[];
  statusFilters: FilterOption[];
  resourceFilters: FilterOption[];
}

/**
 * Client component that handles UI interactivity for the schedules page
 * Uses API-based client service for client-side filtering
 * Receives initial data from server component
 */
export default function SchedulesClientAPI({
  initialSchedules,
  statusFilters,
  resourceFilters,
}: SchedulesClientAPIProps) {
  const router = useRouter();

  // Data state
  const [schedules, setSchedules] = useState<UISchedule[]>(initialSchedules);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalItems, setTotalItems] = useState(0);

  // UI state
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [resourceFilter, setResourceFilter] = useState("all");
  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
  const [selectedSchedules, setSelectedSchedules] = useState<string[]>([]);
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [limit, setLimit] = useState(10);

  const { toast } = useToast();

  // Refresh schedules from API
  const loadSchedules = async (page = currentPage, pageLimit = limit) => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (statusFilter !== "all") params.append('status', statusFilter);
      if (resourceFilter !== "all") params.append('resource', resourceFilter);
      if (searchTerm) params.append('search', searchTerm);
      params.append('page', String(page));
      params.append('limit', String(pageLimit));

      const url = `/api/schedules?${params.toString()}`;
      const response = await fetch(url);
      const result = await response.json();

      if (!response.ok) throw new Error(result.error || 'Failed to load schedules');
      if (!result.success) throw new Error(result.error || 'Failed to load schedules');

      setSchedules(result.data);
      setTotalItems(result.meta?.total ?? result.data.length);
    } catch (err) {
      console.error("Error loading schedules:", err);
      setError(err instanceof Error ? err.message : "Failed to load schedules");
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to load schedules",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  // Server-side filtering — schedules already filtered by API
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

  const exportSchedules = () => {
    // Create CSV content
    const headers = [
      "Name",
      "Start Time",
      "End Time",
      "Timezone",
      "Active",
      "Days",
      "Description",
      "Created By",
      "Updated By",
      "Created At",
      "Updated At",
    ];

    const csvContent = [
      headers.join(","),
      ...schedules.map((schedule) =>
        [
          `"${schedule.name}"`,
          schedule.starttime,
          schedule.endtime,
          schedule.timezone,
          schedule.active ? "Yes" : "No",
          `"${schedule.days.join(",")}"`,
          `"${schedule.description || ""}"`,
          `"${schedule.createdBy || ""}"`,
          `"${schedule.updatedBy || ""}"`,
          schedule.createdAt || "",
          schedule.updatedAt || "",
        ].join(",")
      ),
    ].join("\n");

    // Create download link
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `schedules-export-${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const refreshSchedules = () => {
    loadSchedules();
  };

  const handleCreateSchedule = () => {
    router.push("/app/schedules/create");
  };

  // Handle schedule updates - this will be called by child components
  const handleScheduleUpdated = (message?: string) => {
    loadSchedules(); // Refresh the schedules list
    
    if (message) {
      toast({
        title: "Success",
        description: message,
      });
    }
  };

  // Load schedules when filters or pagination change
  useEffect(() => {
    loadSchedules(currentPage, limit);
  }, [statusFilter, searchTerm, resourceFilter, currentPage, limit]);

  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Schedules</h1>
          <p className="text-muted-foreground">
            Manage your cost optimization schedules
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleCreateSchedule}>
            <Plus className="mr-2 h-4 w-4" />
            Create Schedule
          </Button>
          <Button variant="outline" onClick={refreshSchedules} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh
          </Button>
          <Button variant="outline" onClick={() => setImportDialogOpen(true)}>
            Import
          </Button>
          <Button variant="outline" onClick={exportSchedules}>
            Export
          </Button>
        </div>
      </div>

      {/* Error alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Selection info */}
      {selectedSchedules.length > 0 && (
        <div className="-mt-4">
          <Card>
            <CardContent className="p-3">
              <p className="text-sm text-muted-foreground">
                {selectedSchedules.length} schedule(s) selected
                {selectedSchedules.length > 0 && (
                  <Button
                    variant="link"
                    size="sm"
                    className="p-0 h-auto text-xs ml-2"
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
            {loading ? (
              <div className="flex justify-center items-center h-32">
                <Loader2 className="h-8 w-8 animate-spin" />
              </div>
            ) : (
              <SchedulesTable
                schedules={filteredSchedules}
                selectedSchedules={selectedSchedules}
                onSelectAll={handleSelectAll}
                onSelectSchedule={handleSelectSchedule}
                onScheduleUpdated={handleScheduleUpdated}
              />
            )}
          </TabsContent>

          <TabsContent value="grid" className="space-y-4">
            {loading ? (
              <div className="flex justify-center items-center h-32">
                <Loader2 className="h-8 w-8 animate-spin" />
              </div>
            ) : (
              <SchedulesGrid
                schedules={filteredSchedules}
                selectedSchedules={selectedSchedules}
                onSelectSchedule={handleSelectSchedule}
                onScheduleUpdated={handleScheduleUpdated}
              />
            )}
          </TabsContent>
        </Tabs>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex justify-center items-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      )}

      {/* Pagination */}
      {!loading && totalItems > 0 && (
        <div className="grid grid-cols-3 items-center rounded-lg border bg-card px-4 py-3">
          <span className="whitespace-nowrap text-sm text-muted-foreground">
            Showing {(currentPage - 1) * limit + 1}–{Math.min(currentPage * limit, totalItems)} of {totalItems} schedules
          </span>
          <div className="flex items-center justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={() => setCurrentPage(p => p - 1)}
              disabled={currentPage === 1}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="px-2 text-sm font-medium tabular-nums">
              Page {currentPage} of {Math.ceil(totalItems / limit)}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={() => setCurrentPage(p => p + 1)}
              disabled={currentPage * limit >= totalItems}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center justify-end gap-2">
            <span className="whitespace-nowrap text-sm text-muted-foreground">Rows per page</span>
            <Select
              value={String(limit)}
              onValueChange={(val) => { setLimit(Number(val)); setCurrentPage(1); }}
            >
              <SelectTrigger className="h-8 w-[70px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
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
          if (!open) loadSchedules();
        }}
      />
    </div>
  );
}

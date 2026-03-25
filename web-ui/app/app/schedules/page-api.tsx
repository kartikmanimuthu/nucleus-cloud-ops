import { Suspense } from "react";
import { cookies } from "next/headers";
import { ScheduleService } from "@/lib/schedule-service";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import SchedulesClientAPI from "@/components/schedules/schedules-client-component-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

interface FilterOption {
  value: string;
  label: string;
}

/**
 * Loading component for the schedules page
 */
function SchedulesLoading() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="flex flex-col items-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="text-muted-foreground">Loading schedules...</p>
      </div>
    </div>
  );
}

/**
 * Server component that fetches initial data for the schedules page
 * Uses server-side rendering for initial data load
 * Delegates client-side interactivity to the client component
 */
export default async function SchedulesPageAPI() {
  try {
    // Get cookies for authentication context
    const cookieStore = await cookies();
    const user = cookieStore.get("user")?.value || "system";
    
    console.log("SchedulesPage - Fetching initial data for user:", user);
    
    // Fetch initial data server-side
    const schedules = await ScheduleService.getSchedules();
    
    // Transform to UI format
    const uiSchedules = schedules.map((schedule: any) => ({
      ...schedule,
      active: schedule.active === true || schedule.active === "true",
    }));
    
    // Prepare filter options
    const statusFilters: FilterOption[] = [
      { value: "all", label: "All Statuses" },
      { value: "active", label: "Active" },
      { value: "inactive", label: "Inactive" },
    ];
    
    // Get unique resource types for filter dropdown
    const allResourceTypes = uiSchedules.flatMap(
      (schedule) => schedule.resourceTypes || []
    );
    const uniqueResourceTypes = Array.from(new Set(allResourceTypes));
    
    const resourceFilters: FilterOption[] = [
      { value: "all", label: "All Resources" },
      ...uniqueResourceTypes.map((resource: string) => ({
        value: resource,
        label: resource,
      })),
    ];
    
    console.log(
      "SchedulesPage - Initial data loaded:",
      uiSchedules.length,
      "schedules"
    );
    
    return (
      <div className="container py-8">
        <Suspense fallback={<SchedulesLoading />}>  
          <SchedulesClientAPI
            initialSchedules={uiSchedules}
            statusFilters={statusFilters}
            resourceFilters={resourceFilters}
          />
        </Suspense>
      </div>
    );
  } catch (error) {
    console.error("SchedulesPage - Error loading data:", error);
    return (
      <div className="container py-8">
        <Card>
          <CardHeader>
            <CardTitle>Error Loading Schedules</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-destructive">
              {error instanceof Error
                ? error.message
                : "Failed to load schedules. Please try again later."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }
}

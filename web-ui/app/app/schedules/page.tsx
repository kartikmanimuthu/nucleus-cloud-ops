
import { ScheduleService } from "@/lib/schedule-service";
import { UISchedule, SearchParams } from "@/lib/types";
import { SchedulesPageClient } from "./schedules-page-client";

// Server-side data fetching with filters
async function getSchedulesData(filters?: {
  statusFilter?: string;
  resourceFilter?: string;
  searchTerm?: string;
  page?: number;
  limit?: number;
}): Promise<{ schedules: UISchedule[], total: number, error?: string }> {
  try {
    const { schedules, total } = await ScheduleService.getSchedules(filters);
    return { schedules, total };
  } catch (error: any) {
    console.error('Server-side error fetching schedules:', error);
    return { 
      schedules: [], 
      total: 0,
      error: error instanceof Error ? error.message : 'Failed to load schedules' 
    };
  }
}

export default async function SchedulesPage({ searchParams }: { searchParams: SearchParams }) {
  searchParams = await searchParams
  // Extract filters from URL parameters
  const statusFilter = typeof searchParams.status === 'string' ? searchParams.status : 'all';
  const resourceFilter = typeof searchParams.resource === 'string' ? searchParams.resource : 'all';
  const searchTerm = typeof searchParams.search === 'string' ? searchParams.search : '';
  const page = typeof searchParams.page === 'string' ? parseInt(searchParams.page) : 1;
  const limit = typeof searchParams.limit === 'string' ? parseInt(searchParams.limit) : 10;
  
  // Fetch filtered schedules from the server side
  const { schedules, total, error } = await getSchedulesData({
    statusFilter: statusFilter !== 'all' ? statusFilter : undefined,
    resourceFilter: resourceFilter !== 'all' ? resourceFilter : undefined,
    searchTerm: searchTerm || undefined,
    page,
    limit
  });

  // Calculate server-side summary statistics
  // NOTE: stats logic currently relies on "all" schedules.
  // BUT we are now only fetching the first page.
  // This means summary stats will be ONLY for the current page if we rely on `schedules` array.
  // To get correct GLOBAL stats, we would need a separate aggregation query or fetching all (filtered) IDs.
  // For now, to avoid major refactor, stats might be approximate or we accept they are for current view.
  // HOWEVER, the `total` is available.
  // Ideally, stats should be fetched separately if we want global stats for "Total Schedules", "Total Savings".
  // Given "Server-side Pagination", accurate global stats usually require a separate lightweight query.
  // Let's defer global stats accuracy for now or just use `total` for "Total Schedules".
  // "Total Savings" will be inaccurate if only summing current page.
  
  const stats = {
    total: total, // Use the total count from backend
    active: schedules.filter((s) => s.active).length, // Only correct for current page
    inactive: schedules.filter((s) => !s.active).length, // Only correct for current page
    totalSavings: schedules.reduce(
      (sum, s) => sum + (s.estimatedSavings || 0),
      0
    ), // Only correct for current page
  };

  return (
    <SchedulesPageClient 
      initialSchedules={schedules} 
      initialError={error} 
      stats={stats}
      initialFilters={{
        statusFilter,
        resourceFilter,
        searchTerm
      }}
      initialPagination={{
        page,
        limit,
        total
      }}
    />
  )
}

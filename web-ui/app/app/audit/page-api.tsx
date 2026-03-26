import { Suspense } from "react";
import { cookies } from "next/headers";
import { AuditService } from "@/lib/audit-service";
import AuditClientAPI from "@/components/audit/audit-client-component-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

/**
 * Loading component for the audit page
 */
function AuditLoading() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="flex flex-col items-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="text-muted-foreground">Loading audit logs...</p>
      </div>
    </div>
  );
}

/**
 * Server component that fetches initial data for the audit page
 * Uses server-side rendering for initial data load
 * Delegates client-side interactivity to the client component
 */
export default async function AuditPageAPI() {
  try {
    // Get cookies for authentication context
    const cookieStore = await cookies();
    const user = cookieStore.get("user")?.value || "system";
    
    console.log("AuditPage - Fetching initial data for user:", user);
    
    // Fetch initial data server-side
    const [logs, stats] = await Promise.all([
      AuditService.getAuditLogs({ limit: 100 }),
      AuditService.getAuditLogStats({}),
    ]);
    
    // Transform stats to match client expectations
    const mappedStats = {
      totalLogs: stats.totalLogs,
      errorCount: stats.errorCount,
      warningCount: stats.warningCount,
      successCount: stats.successCount,
    };
    
    console.log("AuditPage - Initial data loaded:", logs.length, "logs");
    
    return (
      <div className="container py-8">
        <Suspense fallback={<AuditLoading />}>  
          <AuditClientAPI
            logsResponse={logs}
            statsResponse={mappedStats}
            mappedStats={mappedStats}
          />
        </Suspense>
      </div>
    );
  } catch (error) {
    console.error("AuditPage - Error loading data:", error);
    return (
      <div className="container py-8">
        <Card>
          <CardHeader>
            <CardTitle>Error Loading Audit Logs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-destructive">
              {error instanceof Error
                ? error.message
                : "Failed to load audit logs. Please try again later."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }
}


import { DashboardClient, DashboardStats, RecentActivity } from "@/components/dashboard/dashboard-client";
import { ScheduleService } from "@/lib/schedule-service";
import { AccountService } from "@/lib/account-service";
import { AuditService } from "@/lib/audit-service";
import { UISchedule } from "@/lib/types";

// Server-side data fetching
async function getDashboardData(): Promise<{
  initialStats: DashboardStats;
  recentActivity: RecentActivity[];
  auditLogs: any[];
  schedules: UISchedule[];
  accounts: any[];
  error?: string;
}> {
  try {
    // Fetch accounts, schedules, and audit logs in parallel
    const [accounts, schedules, auditLogs] = await Promise.all([
      AccountService.getAccounts().catch(() => {
        console.error("Failed to fetch accounts");
        return { accounts: [] };
      }),
      ScheduleService.getSchedules().catch(() => {
         console.error("Failed to fetch schedules");
         return { schedules: [] };
      }),
      AuditService.getAuditLogs().catch(() => {
         console.error("Failed to fetch audit logs");
         return [];
      }),
    ]);

    // Handle the structure returned by services (some return { accounts: [], nextToken... })
    const accountList = Array.isArray(accounts) ? accounts : (accounts as any).accounts || [];
    const scheduleList = Array.isArray(schedules) ? schedules : (schedules as any).schedules || [];
    const auditLogList = Array.isArray(auditLogs) ? auditLogs : [];

    // Calculate dashboard stats from real data
    const totalAccounts = accountList.length;
    const totalSchedules = scheduleList.length;
    const activeSchedules = scheduleList.filter((s: UISchedule) => s.active).length;
    
    // Calculate total savings - check both account savings and schedule estimated savings
    let totalSavings = accountList.reduce(
      (sum: number, acc: any) => sum + (acc.monthlySavings || 0),
      0
    );

    // If account savings are 0, try to sum up estimated savings from schedules
    if (totalSavings === 0 && scheduleList.length > 0) {
      totalSavings = scheduleList.reduce(
        (sum: number, sch: UISchedule) => sum + (sch.estimatedSavings || 0),
        0
      );
    }

    const totalResources = accountList.reduce(
      (sum: number, acc: any) => sum + (acc.resourceCount || 0),
      0
    );

    const initialStats: DashboardStats = {
      totalSchedules,
      activeSchedules,
      totalAccounts,
      monthlySavings: totalSavings,
      resourcesManaged: totalResources,
      lastExecution: auditLogList.length > 0 ? auditLogList[0].timestamp : new Date().toISOString(),
    };

    // Transform audit logs to recent activity format
    const recentActivity: RecentActivity[] = auditLogList
      .slice(0, 5)
      .map((log: any) => ({
        id: log.id,
        action: log.action,
        schedule: log.resourceType === "schedule" ? log.resource : null,
        account: log.accountId || log.resourceId || "Unknown",
        timestamp: log.timestamp,
        status: log.status,
      }));

    // Add fallback activity if no audit logs
    if (recentActivity.length === 0) {
      recentActivity.push({
        id: "sys-welcome",
        action: "Dashboard initialized",
        schedule: null,
        account: "system",
        timestamp: new Date().toISOString(),
        status: "success",
      });
    }

    return {
      initialStats,
      recentActivity,
      auditLogs: auditLogList,
      schedules: scheduleList,
      accounts: accountList,
    };
  } catch (error) {
    console.error("Error fetching dashboard data:", error);

    // Return fallback data on error
    const fallbackStats: DashboardStats = {
      totalSchedules: 0,
      activeSchedules: 0,
      totalAccounts: 0,
      monthlySavings: 0,
      resourcesManaged: 0,
      lastExecution: new Date().toISOString(),
    };

    const fallbackActivity: RecentActivity[] = [
      {
        id: "error-1",
        action: "Failed to load dashboard data",
        schedule: null,
        account: "system",
        timestamp: new Date().toISOString(),
        status: "error",
      },
    ];

    return {
      initialStats: fallbackStats,
      recentActivity: fallbackActivity,
      auditLogs: [],
      error:
        error instanceof Error
          ? error.message
          : "Failed to load dashboard data",
      schedules: [],
      accounts: [],
    };
  }
}

// Update Dashboard component
export default async function Dashboard() {
  const { initialStats, recentActivity, auditLogs, error, schedules, accounts } =
    await getDashboardData();
  
  if (error) {
    console.error("Dashboard error:", error);
  }


  return (
    <DashboardClient 
      initialStats={initialStats} 
      recentActivity={recentActivity} 
      error={error} 
    />
  );
}
"use client";

import {
  Activity,
  Calendar,
  DollarSign,
  Server,
  TrendingDown,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface DashboardStats {
  totalSchedules: number;
  activeSchedules: number;
  totalAccounts: number;
  monthlySavings: number;
  resourcesManaged: number;
  lastExecution: string;
}

export interface RecentActivity {
  id: string;
  action: string;
  schedule: string | null;
  account: string;
  timestamp: string;
  status: string;
}

interface DashboardClientProps {
  initialStats: DashboardStats;
  recentActivity: RecentActivity[];
  error?: string;
}

export function DashboardClient({
  initialStats,
  recentActivity,
  error,
}: DashboardClientProps) {
  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6 bg-background">
      {/* Header */}
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight text-foreground">
          Cost Optimization Dashboard
        </h2>
      </div>

      {/* Stats Overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Total Schedules
            </CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-card-foreground">
              {initialStats.totalSchedules}
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="text-success dark:text-success">
                {initialStats.activeSchedules} active
              </span>
            </p>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              AWS Accounts
            </CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-card-foreground">
              {initialStats.totalAccounts}
            </div>
            <p className="text-xs text-muted-foreground">
              Across multiple regions
            </p>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Monthly Savings
            </CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-card-foreground">
              ${initialStats.monthlySavings.toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">
              <TrendingDown className="inline h-3 w-3 text-success dark:text-success" />{" "}
              Estimated savings
            </p>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Resources Managed
            </CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-card-foreground">
              {initialStats.resourcesManaged}
            </div>
            <p className="text-xs text-muted-foreground">
              EC2, RDS, ECS, ElastiCache
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Placeholder for Future Events */}
      <Card className="border-border bg-card border-dashed">
        <CardHeader>
          <CardTitle className="text-lg font-medium text-card-foreground">
            Schedule Run Events
          </CardTitle>
          <CardDescription>
            Detailed timeline of schedule executions and system events will appear here.
          </CardDescription>
        </CardHeader>
        <CardContent className="h-48 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
             <Activity className="h-10 w-10 mx-auto mb-2 opacity-50" />
             <p>Events implementation coming soon</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


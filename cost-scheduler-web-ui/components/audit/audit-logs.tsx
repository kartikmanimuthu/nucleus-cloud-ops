"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Activity,
  AlertCircle,
} from "lucide-react";
import { AuditLog } from "@/lib/types";
import { AuditService } from "@/lib/client-audit-service";
import { formatDateTime } from "@/lib/date-utils";

export function AuditLogs({
  auditLogs,
  loading,
  error,
}: {
  auditLogs: AuditLog[];
  loading: boolean;
  error: any
}) {
  // const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  // const [loading, setLoading] = useState(true);
  // const [error, setError] = useState<string | null>(null);

  // useEffect(() => {
  //   const fetchAuditLogs = async () => {
  //     try {
  //       setLoading(true);
  //       setError(null);        // Fetch recent audit logs (last 2 days, limit to 10 for dashboard)
  //       let logs = await AuditService.getAuditLogs({
  //         limit: 10,
  //         startDate: new Date(
  //           Date.now() - 2 * 24 * 60 * 60 * 1000
  //         ).toISOString(),
  //         endDate: new Date().toISOString(),
  //       });

  //       console.log('logs with date filter (last 2 days):', logs.length);

  //       // Fallback: If no logs found with 2-day filter, try without date filter
  //       if (logs.length === 0) {
  //         console.log('No logs found in last 2 days, fetching all recent logs...');
  //         logs = await AuditService.getAuditLogs({
  //           limit: 10,
  //         });
  //       }

  //       // Sort by timestamp descending (newest first) to ensure latest come first
  //       logs.sort((a: AuditLog, b: AuditLog) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  //       console.log('logs', logs);


  //       setAuditLogs(logs);
  //     } catch (err) {
  //       console.error("Failed to fetch audit logs:", err);
  //       setError("Failed to load audit logs");
  //       // Fallback to empty array
  //       setAuditLogs([]);
  //     } finally {
  //       setLoading(false);
  //     }
  //   };

  //   fetchAuditLogs();
  // }, []);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return <CheckCircle className="h-4 w-4 text-success" />;
      case "error":
        return <XCircle className="h-4 w-4 text-destructive" />;
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-warning" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "success":
        return (
          <Badge
            variant="default"
            className="bg-success/10 text-green-800"
          >
            Success
          </Badge>
        );
      case "error":
        return <Badge variant="destructive">Error</Badge>;
      case "warning":
        return (
          <Badge
            variant="secondary"
            className="bg-warning/10 text-yellow-800"
          >
            Warning
          </Badge>
        );
      default:
        return <Badge variant="outline">Unknown</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>
              Latest audit events and system activities
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>
              Latest audit events and system activities
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center h-32">
              <AlertCircle className="h-8 w-8 text-destructive mb-2" />
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>
            Latest audit events and system activities
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {auditLogs.length > 0 ? (
              auditLogs.slice(0, 5).map((log) => (
                <div key={log.id} className="flex items-center space-x-4">
                  <div className="flex-shrink-0">
                    {getStatusIcon(log.status)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{log.action}</p>
                    <p className="text-sm text-muted-foreground truncate">
                      {log.resource} • {formatDateTime(log.timestamp)}
                    </p>
                  </div>
                  <div className="flex-shrink-0">
                    {getStatusBadge(log.status)}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-8">
                <Activity className="mx-auto h-12 w-12 text-muted-foreground" />
                <h3 className="mt-2 text-sm font-semibold">
                  No recent activity
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Audit logs will appear here when system activities occur.
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* View All Button */}
      <div className="text-center">
        <Button
          variant="outline"
          onClick={() => (window.location.href = "/audit")}
        >
          <Activity className="mr-2 h-4 w-4" />
          View All Audit Logs
        </Button>
      </div>
    </div>
  );
}

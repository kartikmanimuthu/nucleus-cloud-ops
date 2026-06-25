"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MoreHorizontal,
  Eye,
  Copy,
  ExternalLink,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  User,
  Server,
  Shield,
  Activity,
} from "lucide-react";
import { AuditLogDetailsDialog } from "./audit-log-details-dialog";
import { AuditLog } from "@/lib/types";
import { formatDate, formatTime } from "@/lib/date-utils";
import { useTenant } from "@/lib/tenant-context";

interface AuditLogsTableProps {
  logs: AuditLog[];
  onFilter?: (filters: any) => void;
}

export function AuditLogsTable({ logs, onFilter }: AuditLogsTableProps) {
  const { timezone } = useTenant();
  const [viewingLog, setViewingLog] = useState<AuditLog | null>(null);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return <CheckCircle className="h-4 w-4 text-success" />;
      case "error":
        return <XCircle className="h-4 w-4 text-destructive" />;
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-warning" />;
      case "blocked":
        return <Shield className="h-4 w-4 text-destructive" />;
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
            className="bg-success/10 text-success"
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
            className="bg-warning/10 text-warning"
          >
            Warning
          </Badge>
        );
      case "blocked":
        return (
          <Badge
            variant="destructive"
            className="bg-destructive/10 text-destructive"
          >
            Blocked
          </Badge>
        );
      default:
        return <Badge variant="outline">Unknown</Badge>;
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case "critical":
        return (
          <Badge
            variant="destructive"
            className="bg-destructive/10 text-destructive"
          >
            Critical
          </Badge>
        );
      case "high":
        return (
          <Badge
            variant="secondary"
            className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-100"
          >
            High
          </Badge>
        );
      case "medium":
        return (
          <Badge
            variant="secondary"
            className="bg-warning/10 text-warning"
          >
            Medium
          </Badge>
        );
      case "low":
        return (
          <Badge variant="outline" className="bg-success/10 text-success">
            Low
          </Badge>
        );
      case "info":
        return (
          <Badge
            variant="outline"
            className="bg-info/10 text-info"
          >
            Info
          </Badge>
        );
      default:
        return <Badge variant="outline">Unknown</Badge>;
    }
  };

  const getUserTypeIcon = (userType: string) => {
    switch (userType) {
      case "system":
        return <Server className="h-3 w-3" />;
      case "admin":
        return <Shield className="h-3 w-3" />;
      case "external":
        return <ExternalLink className="h-3 w-3" />;
      default:
        return <User className="h-3 w-3" />;
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    console.log("Copied to clipboard");
  };

  const formatTimestamp = (timestamp: string) => {
    return {
      date: formatDate(timestamp, 'shortDate', timezone),
      time: formatDate(timestamp, 'timeWithSecondsZone', timezone),
    };
  };

  const viewCorrelatedEvents = (correlationId: string) => {
    // Filter logs by correlation ID
    if (onFilter) {
      onFilter({ correlationId });
    }
    console.log("View correlated events:", correlationId);
  };

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Details</TableHead>
              <TableHead className="w-[70px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs && logs.length > 0 ? (
              logs.map((log) => (
                <TableRow key={log.id} className="hover:bg-muted/50">
                  <TableCell>
                    <div className="space-y-1">
                      <div className="text-sm font-medium">
                        {formatTimestamp(log.timestamp).date}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatTimestamp(log.timestamp).time}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="text-sm font-medium">
                        <span 
                          className="cursor-pointer hover:underline text-primary"
                          onClick={() => setViewingLog(log)}
                        >
                          {log.action}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {log.eventType
                          .replace(/\./g, " ")
                          .replace(/\b\w/g, (l) => l.toUpperCase())}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2">
                        {getUserTypeIcon(log.userType)}
                        <span className="text-sm">
                          {log.userType === "system" ? (
                            <Badge variant="outline" className="text-xs">
                              System
                            </Badge>
                          ) : (
                            log.user
                          )}
                        </span>
                      </div>
                      {log.ipAddress !== "internal" && (
                        <div className="text-xs text-muted-foreground font-mono">
                          {log.ipAddress}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="font-medium text-sm">{log.resource}</div>
                      <div className="text-xs text-muted-foreground">
                        {log.resourceType} • {log.resourceId}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center space-x-2">
                      {getStatusIcon(log.status)}
                      {getStatusBadge(log.status)}
                    </div>
                  </TableCell>
                  <TableCell>{getSeverityBadge(log.severity)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {log.source}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-[300px]">
                      <p className="text-sm text-muted-foreground truncate">
                        {log.details}
                      </p>
                      {log.metadata && Object.keys(log.metadata).length > 0 && (
                        <div className="text-xs text-muted-foreground mt-1">
                          +{Object.keys(log.metadata).length} metadata fields
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setViewingLog(log)}>
                          <Eye className="mr-2 h-4 w-4" />
                          View Details
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => copyToClipboard(log.id)}
                        >
                          <Copy className="mr-2 h-4 w-4" />
                          Copy Event ID
                        </DropdownMenuItem>
                        {log.correlationId && (
                          <DropdownMenuItem
                            onClick={() =>
                              viewCorrelatedEvents(log.correlationId!)
                            }
                          >
                            <ExternalLink className="mr-2 h-4 w-4" />
                            View Related Events
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-12">
                  <Activity className="mx-auto h-12 w-12 text-muted-foreground" />
                  <h3 className="mt-2 text-sm font-semibold">
                    No audit logs found
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Try adjusting your search or filter criteria.
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      {/* Details Dialog */}
      {viewingLog && (
        <AuditLogDetailsDialog
          log={viewingLog}
          open={!!viewingLog}
          onOpenChange={(open) => !open && setViewingLog(null)}
        />
      )}
    </Card>
  );
}

"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Activity,
  CheckCircle,
  Clock,
  User,
  Server,
  Shield,
  XCircle,
  AlertTriangle,
  MapPin,
} from "lucide-react";
import { AuditLog } from "@/lib/types";

interface AuditLogDetailsDialogProps {
  log: AuditLog;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AuditLogDetailsDialog({
  log,
  open,
  onOpenChange,
}: AuditLogDetailsDialogProps) {
  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "error":
        return <XCircle className="h-4 w-4 text-red-500" />;
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      default:
        return <Clock className="h-4 w-4 text-gray-400" />;
    }
  };

  const getUserTypeIcon = (userType: string) => {
    switch (userType) {
      case "system":
        return <Server className="h-4 w-4" />;
      case "admin":
        return <Shield className="h-4 w-4" />;
      default:
        return <User className="h-4 w-4" />;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <Activity className="h-5 w-5" />
            <span>Audit Log Details</span>
          </DialogTitle>
          <DialogDescription>
            Detailed information about this audit log entry
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto w-full rounded-md border p-4">
          <div className="space-y-6">
            {/* Basic Information */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Event Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">
                      Event ID
                    </label>
                    <p className="font-mono text-sm">{log.id}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">
                      Timestamp
                    </label>
                    <p className="text-sm">
                      {new Date(log.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">
                      Action
                    </label>
                    <div className="flex items-center space-x-2">
                      <Activity className="h-4 w-4" />
                      <span>{log.action}</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">
                      Event Type
                    </label>
                    <p className="text-sm">{log.eventType}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">
                      Status
                    </label>
                    <div className="flex items-center space-x-2">
                      {getStatusIcon(log.status)}
                      <Badge
                        variant={
                          log.status === "success"
                            ? "default"
                            : log.status === "error"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {log.status}
                      </Badge>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">
                      Severity
                    </label>
                    <Badge
                      variant={
                        log.severity === "critical" ? "destructive" : "outline"
                      }
                    >
                      {log.severity}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* User Information */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">User Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">
                      User
                    </label>
                    <div className="flex items-center space-x-2">
                      {getUserTypeIcon(log.userType)}
                      <span>{log.user}</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">
                      User Type
                    </label>
                    <Badge variant="outline">{log.userType}</Badge>
                  </div>
                </div>

                {log.ipAddress && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">
                        IP Address
                      </label>
                      <p className="font-mono text-sm">{log.ipAddress}</p>
                    </div>
                    {log.sessionId && (
                      <div>
                        <label className="text-sm font-medium text-muted-foreground">
                          Session ID
                        </label>
                        <p className="font-mono text-sm truncate">
                          {log.sessionId}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Resource Information */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Resource Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">
                      Resource
                    </label>
                    <p className="font-medium">{log.resource}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">
                      Resource Type
                    </label>
                    <Badge variant="outline">{log.resourceType}</Badge>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">
                      Resource ID
                    </label>
                    <p className="font-mono text-sm">{log.resourceId}</p>
                  </div>
                  {log.source && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">
                        Source
                      </label>
                      <Badge variant="outline">{log.source}</Badge>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Event Details */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Event Details</CardTitle>
              </CardHeader>
              <CardContent>
                <div>
                  <label className="text-sm font-medium text-muted-foreground">
                    Description
                  </label>
                  <p className="mt-1 text-sm bg-muted p-3 rounded">
                    {log.details}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Additional Information */}
            {(log.correlationId ||
              log.executionId ||
              log.accountId ||
              log.region) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Additional Information
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      {log.correlationId && (
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">
                            Correlation ID
                          </label>
                          <p className="font-mono text-sm">{log.correlationId}</p>
                        </div>
                      )}
                      {log.executionId && (
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">
                            Execution ID
                          </label>
                          <p className="font-mono text-sm">{log.executionId}</p>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      {log.accountId && (
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">
                            Account ID
                          </label>
                          <p className="font-mono text-sm">{log.accountId}</p>
                        </div>
                      )}
                      {log.region && (
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">
                            Region
                          </label>
                          <div className="flex items-center space-x-2">
                            <MapPin className="h-3 w-3" />
                            <span className="text-sm">{log.region}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

            {/* Metadata */}
            {log.metadata && Object.keys(log.metadata).length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Metadata</CardTitle>
                  <CardDescription>Additional event data</CardDescription>
                </CardHeader>
                <CardContent>
                  <pre className="text-xs bg-muted p-3 rounded overflow-auto">
                    {JSON.stringify(log.metadata, null, 2)}
                  </pre>
                </CardContent>
              </Card>
            )}

            {/* Raw DynamoDB Record */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Server className="h-4 w-4" />
                  Raw DynamoDB Record
                </CardTitle>
                <CardDescription>Complete raw record from database</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-64">
                  {JSON.stringify(log, null, 2)}
                </pre>
              </CardContent>
            </Card>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

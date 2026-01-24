"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Database,
  Server,
  Box,
  Cpu,
  Info,
} from "lucide-react";
import { formatDate } from "@/lib/date-utils";

interface ExecutionDetailsDialogProps {
  execution: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExecutionDetailsDialog({
  execution,
  open,
  onOpenChange,
}: ExecutionDetailsDialogProps) {
  if (!execution) return null;

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return <CheckCircle className="h-4 w-4 text-success" />;
      case "error":
      case "failed":
        return <AlertTriangle className="h-4 w-4 text-destructive" />;
      case "partial":
        return <AlertTriangle className="h-4 w-4 text-warning" />;
      default:
        return <Activity className="h-4 w-4 text-muted-foreground" />;
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
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      case "partial":
        return (
          <Badge
            variant="secondary"
            className="bg-warning/10 text-yellow-800"
          >
            Partial
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const metadata = execution.schedule_metadata || { ec2: [], rds: [], ecs: [], asg: [], docdb: [] };
  const ec2Resources = metadata.ec2 || [];
  const rdsResources = metadata.rds || [];
  const ecsResources = metadata.ecs || [];
  const asgResources = metadata.asg || [];
  const docdbResources = metadata.docdb || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <Activity className="h-5 w-5" />
            <span>Execution Details</span>
          </DialogTitle>
          <DialogDescription>
            ID: {execution.executionId || execution.id}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-2">
          <div className="space-y-6">
            {/* Overview Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Execution Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="space-y-1">
                    <span className="text-sm text-muted-foreground">Status</span>
                    <div>{getStatusBadge(execution.status)}</div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-sm text-muted-foreground">Start Time</span>
                    <div className="text-sm font-medium">
                      {formatDate(execution.startTime, { includeTime: true })}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-sm text-muted-foreground">Duration</span>
                    <div className="text-sm font-medium">
                      {execution.duration ? `${execution.duration}s` : "N/A"}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-sm text-muted-foreground">Resources</span>
                    <div className="text-sm font-medium">
                      {execution.resourcesStarted +
                        execution.resourcesStopped +
                        (execution.resourcesFailed || 0)}
                    </div>
                  </div>
                </div>
                {execution.errorMessage && (
                  <div className="mt-4 p-3 bg-destructive/10 text-red-700 rounded-md text-sm flex items-start space-x-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    <span>{execution.errorMessage}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Resources Tabs */}
            <Tabs defaultValue="all" className="w-full">
              <TabsList className="w-full h-auto flex flex-wrap justify-start gap-2 bg-transparent p-0">
                <TabsTrigger value="all" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=inactive]:bg-muted flex-1 min-w-[80px]">All Resources</TabsTrigger>
                <TabsTrigger value="ec2" disabled={ec2Resources.length === 0} className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=inactive]:bg-muted flex-1 min-w-[80px]">
                  EC2 ({ec2Resources.length})
                </TabsTrigger>
                <TabsTrigger value="rds" disabled={rdsResources.length === 0} className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=inactive]:bg-muted flex-1 min-w-[80px]">
                  RDS ({rdsResources.length})
                </TabsTrigger>
                <TabsTrigger value="ecs" disabled={ecsResources.length === 0} className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=inactive]:bg-muted flex-1 min-w-[80px]">
                  ECS ({ecsResources.length})
                </TabsTrigger>
                <TabsTrigger value="asg" disabled={asgResources.length === 0} className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=inactive]:bg-muted flex-1 min-w-[80px]">
                  ASG ({asgResources.length})
                </TabsTrigger>
                <TabsTrigger value="docdb" disabled={docdbResources.length === 0} className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=inactive]:bg-muted flex-1 min-w-[80px]">
                  DocDB ({docdbResources.length})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="all" className="space-y-4 mt-4">
                {ec2Resources.length === 0 &&
                rdsResources.length === 0 &&
                ecsResources.length === 0 &&
                asgResources.length === 0 &&
                docdbResources.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Info className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No detailed resource information available.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {ec2Resources.length > 0 && (
                      <ResourceSection
                        title="EC2 Instances"
                        icon={<Server className="h-4 w-4" />}
                        resources={ec2Resources}
                        type="ec2"
                      />
                    )}
                    {rdsResources.length > 0 && (
                      <ResourceSection
                        title="RDS Instances"
                        icon={<Database className="h-4 w-4" />}
                        resources={rdsResources}
                        type="rds"
                      />
                    )}
                    {ecsResources.length > 0 && (
                      <ResourceSection
                        title="ECS Services"
                        icon={<Box className="h-4 w-4" />}
                        resources={ecsResources}
                        type="ecs"
                      />
                    )}
                    {asgResources.length > 0 && (
                      <ResourceSection
                        title="Auto Scaling Groups"
                        icon={<Cpu className="h-4 w-4" />}
                        resources={asgResources}
                        type="asg"
                      />
                    )}
                    {docdbResources.length > 0 && (
                      <ResourceSection
                        title="DocumentDB Clusters"
                        icon={<Database className="h-4 w-4" />}
                        resources={docdbResources}
                        type="docdb"
                      />
                    )}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="ec2" className="mt-4">
                <ResourceSection
                  title="EC2 Instances"
                  icon={<Server className="h-4 w-4" />}
                  resources={ec2Resources}
                  type="ec2"
                />
              </TabsContent>

              <TabsContent value="rds" className="mt-4">
                <ResourceSection
                  title="RDS Instances"
                  icon={<Database className="h-4 w-4" />}
                  resources={rdsResources}
                  type="rds"
                />
              </TabsContent>

              <TabsContent value="ecs" className="mt-4">
                <ResourceSection
                  title="ECS Services"
                  icon={<Box className="h-4 w-4" />}
                  resources={ecsResources}
                  type="ecs"
                />
              </TabsContent>

              <TabsContent value="asg" className="mt-4">
                <ResourceSection
                  title="Auto Scaling Groups"
                  icon={<Cpu className="h-4 w-4" />}
                  resources={asgResources}
                  type="asg"
                />
              </TabsContent>

              <TabsContent value="docdb" className="mt-4">
                <ResourceSection
                  title="DocumentDB Clusters"
                  icon={<Database className="h-4 w-4" />}
                  resources={docdbResources}
                  type="docdb"
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResourceSection({
  title,
  icon,
  resources,
  type,
}: {
  title: string;
  icon: React.ReactNode;
  resources: any[];
  type: "ec2" | "rds" | "ecs" | "asg" | "docdb";
}) {
  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm font-medium flex items-center space-x-2">
          {icon}
          <span>{title}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2">
        <div className="space-y-2">
          {resources.map((res: any, idx: number) => (
            <div
              key={idx}
              className="flex items-start justify-between p-3 border rounded-md bg-muted/30"
            >
              <div className="space-y-1">
                <div className="flex items-center space-x-2">
                  <span className="font-medium text-sm">
                    {res.resourceId || res.arn.split("/").pop()}
                  </span>
                  <Badge variant="outline" className="text-xs">
                    {res.action}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground break-all">
                  {res.arn}
                </div>
                {res.error && (
                  <p className="text-xs text-destructive mt-1">{res.error}</p>
                )}
                {type === "ecs" && res.last_state && (
                    <div className="text-xs text-muted-foreground mt-1">
                        Desired Count: {res.last_state.desiredCount} → Running: {res.last_state.runningCount}
                    </div>
                )}
                {type === "asg" && res.last_state && (
                    <div className="text-xs text-muted-foreground mt-1">
                        Capacity: Min {res.last_state.minSize} / Max {res.last_state.maxSize} / Desired {res.last_state.desiredCapacity}
                    </div>
                )}
              </div>
              <div className="flex-shrink-0">
                {res.status === "success" ? (
                  <Badge
                    variant="default"
                    className="bg-success/10 text-green-800 hover:bg-success/10"
                  >
                    Success
                  </Badge>
                ) : (
                  <Badge variant="destructive">Failed</Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

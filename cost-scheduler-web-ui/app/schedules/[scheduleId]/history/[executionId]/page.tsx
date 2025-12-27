"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Database,
  Server,
  Box,
  Info,
  ArrowLeft,
  Loader2,
} from "lucide-react";
import { formatDateTime } from "@/lib/date-utils";

import { use } from "react";

interface ExecutionDetailsPageProps {
  params: Promise<{
    scheduleId: string;
    executionId: string;
  }>;
}

export default function ExecutionDetailsPage({ params }: ExecutionDetailsPageProps) {
  const { scheduleId, executionId } = use(params);
  const router = useRouter();
  const [execution, setExecution] = useState<any>(null);
  const [schedule, setSchedule] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchExecution = async () => {
      try {
        const decodedScheduleId = decodeURIComponent(scheduleId);
        const decodedExecutionId = decodeURIComponent(executionId);

        const response = await fetch(
          `/api/schedules/${decodedScheduleId}/history/${decodedExecutionId}`
        );
        const data = await response.json();

        if (data.success) {
          setExecution(data.execution);
          setSchedule(data.schedule);
        } else {
          setError(data.error || "Failed to load execution details");
        }
      } catch (err) {
        console.error("Error fetching execution:", err);
        setError("Failed to load execution details");
      } finally {
        setLoading(false);
      }
    };

    fetchExecution();
  }, [scheduleId, executionId]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case "error":
      case "failed":
        return <AlertTriangle className="h-5 w-5 text-red-500" />;
      case "partial":
        return <AlertTriangle className="h-5 w-5 text-yellow-500" />;
      default:
        return <Activity className="h-5 w-5 text-gray-400" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "success":
        return (
          <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100">
            Success
          </Badge>
        );
      case "error":
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      case "partial":
        return (
          <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-100">
            Partial
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background p-6 flex items-center justify-center">
        <div className="flex items-center space-x-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading execution details...</span>
        </div>
      </div>
    );
  }

  if (error || !execution) {
    return (
      <div className="min-h-screen bg-background p-6 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Execution Not Found</h1>
          <p className="text-muted-foreground mb-4">
            {error || "The requested execution could not be found."}
          </p>
          <Link href={`/schedules/${scheduleId}`}>
            <Button>Back to Schedule</Button>
          </Link>
        </div>
      </div>
    );
  }

  // Filter resources to only show start/stop actions (exclude skip)
  const metadata = execution.schedule_metadata || { ec2: [], rds: [], ecs: [] };
  const filterActioned = (resources: any[]) => 
    (resources || []).filter((r: any) => r.action === 'start' || r.action === 'stop');
  
  const ec2Resources = filterActioned(metadata.ec2);
  const rdsResources = filterActioned(metadata.rds);
  const ecsResources = filterActioned(metadata.ecs);
  const totalResources = ec2Resources.length + rdsResources.length + ecsResources.length;

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Link href={`/schedules/${encodeURIComponent(scheduleId)}`}>
              <Button variant="outline" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Schedule
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                {getStatusIcon(execution.status)}
                Execution Details
              </h1>
              <p className="text-muted-foreground">
                {schedule?.name} • {formatDateTime(execution.executionTime || execution.startTime)}
              </p>
            </div>
          </div>
          <div>{getStatusBadge(execution.status)}</div>
        </div>

        {/* Summary Card */}
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
                  {formatDateTime(execution.executionTime || execution.startTime)}
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-sm text-muted-foreground">Duration</span>
                <div className="text-sm font-medium flex items-center gap-1">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  {execution.duration ? `${execution.duration}s` : "N/A"}
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-sm text-muted-foreground">Total Resources</span>
                <div className="text-sm font-medium">
                  {totalResources} actioned
                </div>
              </div>
            </div>
            {execution.errorMessage && (
              <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-300 rounded-md text-sm flex items-start space-x-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{execution.errorMessage}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Resource Quick Stats */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                Resources Started
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                {execution.resourcesStarted || 0}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="h-4 w-4 text-blue-500" />
                Resources Stopped
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">
                {execution.resourcesStopped || 0}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-500" />
                Resources Failed
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">
                {execution.resourcesFailed || 0}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Resources Tabs */}
        <Card>
          <CardHeader>
            <CardTitle>Resource Details</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="all" className="w-full">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="all">All Resources</TabsTrigger>
                <TabsTrigger value="ec2" disabled={ec2Resources.length === 0}>
                  EC2 ({ec2Resources.length})
                </TabsTrigger>
                <TabsTrigger value="rds" disabled={rdsResources.length === 0}>
                  RDS ({rdsResources.length})
                </TabsTrigger>
                <TabsTrigger value="ecs" disabled={ecsResources.length === 0}>
                  ECS ({ecsResources.length})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="all" className="space-y-4 mt-4">
                {totalResources === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Info className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No resources were started or stopped in this execution.</p>
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
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
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
  type: "ec2" | "rds" | "ecs";
}) {
  if (resources.length === 0) {
    return (
      <div className="text-center py-4 text-muted-foreground">
        <p>No {title.toLowerCase()} were actioned.</p>
      </div>
    );
  }

  return (
    <div className="border rounded-lg">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        {icon}
        <span className="font-medium text-sm">{title}</span>
        <Badge variant="secondary" className="ml-auto">
          {resources.length}
        </Badge>
      </div>
      <div className="p-4 space-y-2">
        {resources.map((res: any, idx: number) => (
          <div
            key={idx}
            className="flex items-start justify-between p-3 border rounded-md bg-muted/30"
          >
            <div className="space-y-1">
              <div className="flex items-center space-x-2">
                <span className="font-medium text-sm">
                  {res.resourceId || res.arn?.split("/").pop()}
                </span>
                <Badge variant="outline" className="text-xs capitalize">
                  {res.action}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground break-all">
                {res.arn}
              </div>
              {res.error && (
                <p className="text-xs text-red-500 mt-1">{res.error}</p>
              )}
              {type === "ecs" && res.last_state && (
                <div className="text-xs text-muted-foreground mt-1">
                  Desired Count: {res.last_state.desiredCount} → Running:{" "}
                  {res.last_state.runningCount}
                </div>
              )}
            </div>
            <div className="flex-shrink-0">
              {res.status === "success" ? (
                <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
                  Success
                </Badge>
              ) : (
                <Badge variant="destructive">Failed</Badge>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

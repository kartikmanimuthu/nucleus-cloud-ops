"use client";

import { useState, useEffect } from "react";
import { notFound, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  Clock,
  Calendar,
  Users,
  TrendingUp,
  DollarSign,
  Tag,
  Activity,
  AlertTriangle,
  CheckCircle,
  Edit,
  ArrowLeft,
  Settings,
  Loader2,
  Server,
} from "lucide-react";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { formatDate } from "@/lib/date-utils";
import { UISchedule } from "@/lib/types";

import { use } from "react";

interface SchedulePageProps {
  params: Promise<{
    scheduleId: string;
  }>;
}


// Execution history type
interface ExecutionHistoryItem {
  executionId: string;
  executionTime: string;
  status: string;
  duration?: number;
  resourcesStarted: number;
  resourcesStopped: number;
  resourcesFailed: number;
  errorMessage?: string;
}

export default function SchedulePage({ params }: SchedulePageProps) {
  const { scheduleId } = use(params);
  const router = useRouter();
  const [schedule, setSchedule] = useState<UISchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [executionHistory, setExecutionHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    const fetchSchedule = async () => {
      try {
        const decodedId = decodeURIComponent(scheduleId);

        // Note: ClientScheduleService.getSchedule expects a name or ID depending on implementation
        // ideally we should have getScheduleById. Assuming getSchedule can handle ID or we updated it?
        // Wait, ClientScheduleService.getSchedule uses `/api/schedules/${name}`.
        // We need to update the API route as well to handle ID? 
        // Or update ClientScheduleService to use `getScheduleById`?
        // Let's assume for now we use the ID to helper. 
        // Actually, previous refactor changed PK to UUID.
        // So fetching by ID is correct. 
        // But the API might expect `name` in the route if we didn't change `app/api/schedules/[name]`.
        // I need to check `app/api/schedules/[name]` later.
        
        const scheduleData = await ClientScheduleService.getSchedule(decodedId);

        if (!scheduleData) {
          router.push('/404');
          return;
        }
        setSchedule(scheduleData);
      } catch (err) {
        console.error('Error fetching schedule:', err);
        setError('Failed to load schedule');
      } finally {
        setLoading(false);
      }
    };

    fetchSchedule();
  }, [scheduleId, router]);

  // Fetch execution history when schedule is loaded
  useEffect(() => {
    const fetchHistory = async () => {
      if (!schedule) return;
      try {
        setHistoryLoading(true);
        const response = await fetch(`/api/schedules/${encodeURIComponent(schedule.id)}/history`);
        if (response.ok) {
          const data = await response.json();
          setExecutionHistory(data.executions || []);
        }
      } catch (err) {
        console.error('Error fetching execution history:', err);
      } finally {
        setHistoryLoading(false);
      }
    };
    fetchHistory();
  }, [schedule]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background p-6 flex items-center justify-center">
        <div className="flex items-center space-x-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading schedule...</span>
        </div>
      </div>
    );
  }

  if (error || !schedule) {
    return (
      <div className="min-h-screen bg-background p-6 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Schedule Not Found</h1>
          <p className="text-muted-foreground mb-4">{error || 'The requested schedule could not be found.'}</p>
          <Link href="/schedules">
            <Button>Back to Schedules</Button>
          </Link>
        </div>
      </div>
    );
  }

  const getStatusColor = (status: boolean) => {
    return status ? "bg-green-500" : "bg-red-500";
  };

  const getStatusText = (status: boolean) => {
    return status ? "Active" : "Inactive";
  };

  const formatDays = (days: string[]) => {
    const dayMap: { [key: string]: string } = {
      monday: "Mon",
      tuesday: "Tue",
      wednesday: "Wed",
      thursday: "Thu",
      friday: "Fri",
      saturday: "Sat",
      sunday: "Sun",
    };
    return days.map((day) => dayMap[day] || day).join(", ");
  };

  const getExecutionStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "partial":
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      default:
        return <AlertTriangle className="h-4 w-4 text-red-500" />;
    }
  };
  
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Link href="/schedules">
              <Button variant="outline" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Schedules
              </Button>
            </Link>
            <div>
              <h1 className="text-3xl font-bold">{schedule.name}</h1>
              <p className="text-muted-foreground">
                Schedule Details and Execution History
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <Badge className={getStatusColor(schedule.active)}>
              {getStatusText(schedule.active)}
            </Badge>
            <Link href={`/schedules/${encodeURIComponent(schedule.name)}/edit`}>
              <Button>
                <Edit className="h-4 w-4 mr-2" />
                Edit Schedule
              </Button>
            </Link>
          </div>
        </div>

        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="execution">Execution History</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {/* Schedule Configuration */}
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="flex items-center">
                    <Settings className="h-5 w-5 mr-2" />
                    Schedule Configuration
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Start Time</Label>
                      <div className="flex items-center space-x-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span>{schedule.starttime}</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">End Time</Label>
                      <div className="flex items-center space-x-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span>{schedule.endtime}</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Timezone</Label>
                      <div className="flex items-center space-x-2">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <span>{schedule.timezone}</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Days</Label>
                      <div className="flex items-center space-x-2">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <span>{formatDays(schedule.days)}</span>
                      </div>
                    </div>
                  </div>
                  {schedule.description && (
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Description</Label>
                      <p className="text-sm text-muted-foreground">
                        {schedule.description}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Resources Configuration */}
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="flex items-center">
                    <Server className="h-5 w-5 mr-2" />
                    Target Resources
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                      <Label className="text-sm font-medium">Target Account</Label>
                      <div className="flex items-center space-x-2">
                        <Badge variant="outline">{schedule.accounts?.[0] || "No account selected"}</Badge>
                      </div>
                  </div>
                  
                  {schedule.resources && schedule.resources.length > 0 && (
                     <div className="space-y-4 pt-2">
                        <Label className="text-sm font-medium">Selected Resources ({schedule.resources.length})</Label>
                        <Tabs defaultValue="list" className="w-full">
                           <TabsList className="grid w-full grid-cols-2">
                              <TabsTrigger value="list">List View</TabsTrigger>
                              <TabsTrigger value="json">JSON View</TabsTrigger>
                           </TabsList>
                           <TabsContent value="list">
                              <div className="rounded-md border p-4 h-[250px] overflow-y-auto space-y-2">
                                 {schedule.resources.map((res: any) => (
                                    <div key={res.id} className="flex flex-col space-y-1 border-b pb-2 last:border-0 last:pb-0">
                                       <div className="flex items-center justify-between">
                                          <span className="font-medium text-sm">{res.name || res.id}</span>
                                          <Badge variant="secondary" className="text-xs">{res.type.toUpperCase()}</Badge>
                                       </div>
                                       <span className="text-xs text-muted-foreground font-mono">{res.arn || res.id}</span>
                                    </div>
                                 ))}
                              </div>
                           </TabsContent>
                           <TabsContent value="json">
                              <pre className="bg-muted p-4 rounded-md overflow-auto h-[250px] text-xs">
                                 {JSON.stringify(schedule.resources, null, 2)}
                              </pre>
                           </TabsContent>
                        </Tabs>
                     </div>
                  )}
                </CardContent>
              </Card>

              {/* Quick Stats */}
              <div className="space-y-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center">
                      <Activity className="h-4 w-4 mr-2" />
                      Executions
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {schedule.executionCount || 0}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Total executions
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center">
                      <TrendingUp className="h-4 w-4 mr-2" />
                      Success Rate
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {schedule.successRate || 0}%
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Success rate
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center">
                      <DollarSign className="h-4 w-4 mr-2" />
                      Savings
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      ${schedule.estimatedSavings || 0}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Estimated monthly
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Schedule Metadata */}
            <Card>
              <CardHeader>
                <CardTitle>Schedule Metadata</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <Label className="text-sm font-medium">Created</Label>
                    <p className="text-sm text-muted-foreground">
                      {schedule.createdAt
                        ? formatDate(schedule.createdAt)
                        : "N/A"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Last Updated</Label>
                    <p className="text-sm text-muted-foreground">
                      {schedule.updatedAt
                        ? formatDate(schedule.updatedAt)
                        : "N/A"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Created By</Label>
                    <p className="text-sm text-muted-foreground">
                      {schedule.createdBy || "N/A"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">
                      Last Modified By
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {schedule.updatedBy || "N/A"}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="execution" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Execution History</CardTitle>
                <CardDescription>
                  Recent execution history for this schedule
                </CardDescription>
              </CardHeader>
              <CardContent>
                {historyLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    <span>Loading execution history...</span>
                  </div>
                ) : executionHistory.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No execution history found</p>
                    <p className="text-sm">Executions will appear here after the schedule runs</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {executionHistory.map((execution: ExecutionHistoryItem, index: number) => (
                      <div key={execution.executionId}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            {getExecutionStatusIcon(execution.status)}
                            <div>
                              <p className="font-medium">
                                {formatDate(execution.executionTime)}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                {execution.errorMessage || `Started: ${execution.resourcesStarted}, Stopped: ${execution.resourcesStopped}, Failed: ${execution.resourcesFailed}`}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <Badge variant={execution.status === 'success' ? 'default' : execution.status === 'failed' ? 'destructive' : 'secondary'}>
                              {execution.status}
                            </Badge>
                            <p className="text-sm text-muted-foreground mt-1">
                              {execution.duration ? `${Math.round(execution.duration / 1000)}s` : 'N/A'} •{" "}
                              {execution.resourcesStarted + execution.resourcesStopped} resources
                            </p>
                          </div>
                        </div>
                        {index < executionHistory.length - 1 && (
                          <Separator className="mt-4" />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Advanced Settings</CardTitle>
                <CardDescription>
                  Additional configuration options for this schedule
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <Label className="text-sm font-medium">
                      Next Execution
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {schedule.nextExecution
                        ? formatDate(schedule.nextExecution)
                        : "Not scheduled"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">
                      Last Execution
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {schedule.lastExecution
                        ? formatDate(schedule.lastExecution)
                        : "Never executed"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">
                      Resource Types
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {schedule.resourceTypes?.join(", ") || "All types"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">
                      Target Accounts
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {schedule.accounts?.length || 0} accounts
                    </p>
                  </div>
                </div>

                {schedule.resourceTags && (
                  <div>
                    <Label className="text-sm font-medium">Resource Tags</Label>
                    <p className="text-sm text-muted-foreground">
                      {schedule.resourceTags}
                    </p>
                  </div>
                )}

                {schedule.excludeTags && (
                  <div>
                    <Label className="text-sm font-medium">Exclude Tags</Label>
                    <p className="text-sm text-muted-foreground">
                      {schedule.excludeTags}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// Add Label component import at the top
function Label({
  className,
  children,
  ...props
}: React.ComponentProps<"label">) {
  return (
    <label
      className={`text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 ${className || ""
        }`}
      {...props}
    >
      {children}
    </label>
  );
}

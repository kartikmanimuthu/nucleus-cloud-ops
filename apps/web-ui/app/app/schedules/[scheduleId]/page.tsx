"use client";

import { useState, useEffect } from "react";
import { notFound, useRouter } from "next/navigation";
import Link from "next/link";
import { useToast } from "@/hooks/use-toast";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { CopyButton } from "@/components/ui/copy-button";
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
  Play,
  MinusCircle,
} from "lucide-react";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { useScheduleExecutions } from "@/lib/queries/schedules";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queries/query-keys";
import { formatDateTime } from "@/lib/date-utils";
import { useTenant } from '@/lib/tenant-context';
import { UISchedule } from "@/lib/types";

import { use } from "react";

interface SchedulePageProps {
  params: Promise<{
    scheduleId: string;
  }>;
}


export default function SchedulePage({ params }: SchedulePageProps) {
  const { scheduleId } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const { timezone } = useTenant();
  const queryClient = useQueryClient();
  const [schedule, setSchedule] = useState<UISchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);

  // Execution history — server-side paginated grid.
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLimit, setHistoryLimit] = useState(10);
  const executionsQuery = useScheduleExecutions(schedule?.id, historyPage, historyLimit);
  const executionHistory = executionsQuery.data?.executions ?? [];
  const historyTotal = executionsQuery.data?.total ?? 0;
  const historyLoading = executionsQuery.isLoading;

  const executeScheduleNow = async () => {
    if (!schedule) return;
    
    try {
      setExecuting(true);
      const response = await fetch(`/api/schedules/${schedule.id}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        toast({
          title: "Schedule Executed",
          description: `Schedule execution started successfully.`,
          variant: "success",
        });
        
        // The scan runs asynchronously in the workers process, so the row lands a
        // moment later. Reset to the first page and refetch after a short delay so
        // the newest execution appears at the top.
        setHistoryPage(1);
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: queryKeys.schedules.detail(schedule.id) });
        }, 1500);
      } else {
        throw new Error('Execution request failed');
      }

    } catch (error) {
      console.error("Error executing schedule:", error);
      toast({
        title: "Execution Failed",
        description: `Failed to execute schedule.`,
        variant: "destructive",
      });
    } finally {
      setExecuting(false);
    }
  };


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
          <Link href="/app/schedules">
            <Button>Back to Schedules</Button>
          </Link>
        </div>
      </div>
    );
  }

  const getStatusColor = (status: boolean) => {
    return status ? "bg-success/100" : "bg-destructive/100";
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
        return <CheckCircle className="h-4 w-4 text-success" />;
      case "partial":
        return <AlertTriangle className="h-4 w-4 text-warning" />;
      case "no_action":
        return <MinusCircle className="h-4 w-4 text-muted-foreground" />;
      case "failed":
        return <AlertTriangle className="h-4 w-4 text-destructive" />;
      default:
        return <Activity className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getExecutionStatusBadge = (status: string) => {
    switch (status) {
      case "success":
        return { variant: "default" as const, label: "Success" };
      case "partial":
        return { variant: "secondary" as const, label: "Partial" };
      case "failed":
        return { variant: "destructive" as const, label: "Failed" };
      case "no_action":
        return { variant: "outline" as const, label: "No action" };
      default:
        return { variant: "secondary" as const, label: status };
    }
  };

  const historyTotalPages = Math.max(1, Math.ceil(historyTotal / historyLimit));
  
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Link href="/app/schedules">
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
            <Button 
              variant="secondary" 
              onClick={executeScheduleNow}
              disabled={executing}
            >
              {executing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              Execute Now
            </Button>
            <Link href={`/app/schedules/${encodeURIComponent(schedule.id)}/edit`}>
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
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            {/* Stat row — moved out of the narrow right rail to a full-width top row */}
            <div className="grid gap-4 sm:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Executions</CardTitle>
                  <Activity className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{schedule.executionCount || 0}</div>
                  <p className="text-xs text-muted-foreground">Total executions</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{schedule.successRate || 0}%</div>
                  <p className="text-xs text-muted-foreground">Success rate</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Savings</CardTitle>
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">${schedule.estimatedSavings || 0}</div>
                  <p className="text-xs text-muted-foreground">Estimated monthly</p>
                </CardContent>
              </Card>
            </div>

            {/* Configuration + Metadata side by side, above the resources grid */}
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Schedule Configuration */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center">
                    <Settings className="h-5 w-5 mr-2" />
                    Schedule Configuration
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
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

              {/* Schedule Metadata — moved up, above the grid */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center">
                    <Tag className="h-5 w-5 mr-2" />
                    Schedule Metadata
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-sm font-medium">Created</Label>
                      <p className="text-sm text-muted-foreground">
                        {schedule.createdAt ? formatDateTime(schedule.createdAt, undefined, timezone) : "N/A"}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-sm font-medium">Last Updated</Label>
                      <p className="text-sm text-muted-foreground">
                        {schedule.updatedAt ? formatDateTime(schedule.updatedAt, undefined, timezone) : "N/A"}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-sm font-medium">Created By</Label>
                      <p className="text-sm text-muted-foreground break-all">{schedule.createdBy || "N/A"}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-sm font-medium">Last Modified By</Label>
                      <p className="text-sm text-muted-foreground break-all">{schedule.updatedBy || "N/A"}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Target Resources — full width so the ARN column has room */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Server className="h-5 w-5 mr-2" />
                  Target Resources
                </CardTitle>
                <CardDescription className="flex items-center gap-2 pt-1">
                  <span>Account</span>
                  <Badge variant="outline">{schedule.accounts?.[0] || "No account selected"}</Badge>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {schedule.resources && schedule.resources.length > 0 ? (
                  <>
                    <Label className="text-sm font-medium">
                      Selected Resources ({schedule.resources.length})
                    </Label>
                    <TargetResourcesTable resources={schedule.resources} />
                  </>
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No resources are targeted by this schedule.
                  </p>
                )}
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
              <CardContent className="space-y-4">
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
                  <div className="rounded-md border overflow-x-auto">
                    <Table className="min-w-[720px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Executed At</TableHead>
                          <TableHead className="w-[130px]">Status</TableHead>
                          <TableHead className="text-right w-[90px]">Started</TableHead>
                          <TableHead className="text-right w-[90px]">Stopped</TableHead>
                          <TableHead className="text-right w-[90px]">Failed</TableHead>
                          <TableHead className="text-right w-[100px]">Duration</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {executionHistory.map((execution) => {
                          const badge = getExecutionStatusBadge(execution.status);
                          return (
                            <TableRow
                              key={execution.executionId}
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() =>
                                router.push(
                                  `/app/schedules/${encodeURIComponent(schedule.id)}/history/${encodeURIComponent(execution.executionId)}`,
                                )
                              }
                            >
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  {getExecutionStatusIcon(execution.status)}
                                  <div>
                                    <div className="font-medium">
                                      {formatDateTime(execution.executionTime, 'longDateTime', timezone)}
                                    </div>
                                    {execution.errorMessage && (
                                      <div className="text-xs text-destructive line-clamp-1 max-w-[280px]">
                                        {execution.errorMessage}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant={badge.variant}>{badge.label}</Badge>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{execution.resourcesStarted}</TableCell>
                              <TableCell className="text-right tabular-nums">{execution.resourcesStopped}</TableCell>
                              <TableCell className="text-right tabular-nums">
                                <span className={execution.resourcesFailed > 0 ? 'text-destructive font-medium' : ''}>
                                  {execution.resourcesFailed}
                                </span>
                              </TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">
                                {execution.duration ? `${Math.round(execution.duration / 1000)}s` : 'N/A'}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {historyTotal > 0 && (
                  <PaginationBar
                    currentPage={historyPage}
                    totalItems={historyTotal}
                    pageSize={historyLimit}
                    onPageChange={(p) => setHistoryPage(Math.min(Math.max(1, p), historyTotalPages))}
                    onPageSizeChange={(size) => {
                      setHistoryLimit(size);
                      setHistoryPage(1);
                    }}
                    pageSizeOptions={[10, 25, 50, 100]}
                    itemLabel="executions"
                  />
                )}
              </CardContent>
            </Card>
          </TabsContent>

        </Tabs>
      </div>
    </div>
  );
}

// Paginated grid of a schedule's configured target resources. Client-side paged —
// a schedule can reference many resources.
function TargetResourcesTable({ resources }: { resources: any[] }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const totalPages = Math.max(1, Math.ceil(resources.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageRows = resources.slice(start, start + pageSize);

  return (
    <div className="space-y-4">
      <div className="rounded-md border overflow-x-auto">
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="min-w-[220px]">Resource</TableHead>
              <TableHead className="w-[90px]">Type</TableHead>
              <TableHead className="min-w-[300px]">ARN</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((res: any, idx: number) => (
              <TableRow key={res.id ?? start + idx}>
                <TableCell className="font-medium text-sm">{res.name || res.id}</TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-xs">
                    {res.type?.toUpperCase()}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <span
                      className="block max-w-[440px] truncate font-mono text-xs text-muted-foreground"
                      title={res.arn || res.id}
                    >
                      {res.arn || res.id}
                    </span>
                    {res.arn && <CopyButton value={res.arn} label="Copy ARN" />}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <PaginationBar
        currentPage={currentPage}
        totalItems={resources.length}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
        pageSizeOptions={[10, 25, 50, 100]}
        itemLabel="resources"
      />
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

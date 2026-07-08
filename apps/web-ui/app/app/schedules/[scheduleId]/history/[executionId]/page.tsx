"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
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
import { CopyButton } from "@/components/ui/copy-button";
import { PaginationBar } from "@/components/ui/pagination-bar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Info,
  ArrowLeft,
  Loader2,
} from "lucide-react";
import { formatDateTime } from "@/lib/date-utils";
import { useTenant } from "@/lib/tenant-context";

import { use } from "react";

interface ExecutionDetailsPageProps {
  params: Promise<{
    scheduleId: string;
    executionId: string;
  }>;
}

export default function ExecutionDetailsPage({ params }: ExecutionDetailsPageProps) {
  const { scheduleId, executionId } = use(params);
  const { timezone } = useTenant();
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
        return <CheckCircle className="h-5 w-5 text-success" />;
      case "error":
      case "failed":
        return <AlertTriangle className="h-5 w-5 text-destructive" />;
      case "partial":
        return <AlertTriangle className="h-5 w-5 text-warning" />;
      default:
        return <Activity className="h-5 w-5 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "success":
        return (
          <Badge className="bg-success/10 text-green-800">
            Success
          </Badge>
        );
      case "error":
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      case "partial":
        return (
          <Badge className="bg-warning/10 text-yellow-800">
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
          <Link href={`/app/schedules/${encodeURIComponent(scheduleId)}`}>
            <Button>Back to Schedule</Button>
          </Link>
        </div>
      </div>
    );
  }

  // Filter resources to only show start/stop actions (exclude skip)
  const metadata = execution.schedule_metadata || { ec2: [], rds: [], ecs: [], asg: [], docdb: [] };
  const filterActioned = (resources: any[]) => 
    (resources || []).filter((r: any) => r.action === 'start' || r.action === 'stop');
  
  const ec2Resources = filterActioned(metadata.ec2);
  const rdsResources = filterActioned(metadata.rds);
  const ecsResources = filterActioned(metadata.ecs);
  const asgResources = filterActioned(metadata.asg);
  const docdbResources = filterActioned(metadata.docdb);
  const totalResources = ec2Resources.length + rdsResources.length + ecsResources.length + asgResources.length + docdbResources.length;

  // Flatten every actioned resource into one list tagged with its type, so the
  // "All Resources" tab renders as a single unified grid (EC2/RDS/ECS/ASG/DocDB
  // together) rather than separate per-type boxes.
  const toRows = (resources: any[], type: ResType) => (resources || []).map((res) => ({ res, type }));
  const allRows: ResourceRow[] = [
    ...toRows(ec2Resources, "ec2"),
    ...toRows(rdsResources, "rds"),
    ...toRows(ecsResources, "ecs"),
    ...toRows(asgResources, "asg"),
    ...toRows(docdbResources, "docdb"),
  ];

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Link href={`/app/schedules/${encodeURIComponent(scheduleId)}`}>
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
                {schedule?.name} • {formatDateTime(execution.executionTime || execution.startTime, 'longDateTime', timezone)}
              </p>
            </div>
          </div>
          <div>{getStatusBadge(execution.status)}</div>
        </div>

        {/* Summary — one compact card (merges the old 3 big count cards inline) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Execution Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Status</span>
                <div>{getStatusBadge(execution.status)}</div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Start Time</span>
                <div className="text-sm font-medium">
                  {formatDateTime(execution.executionTime || execution.startTime, 'longDateTime', timezone)}
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Duration</span>
                <div className="text-sm font-medium flex items-center gap-1">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  {execution.duration ? `${execution.duration}s` : "N/A"}
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Resources ({totalResources} actioned)</span>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-medium">
                  <span className="text-success">{execution.resourcesStarted || 0} started</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-info">{execution.resourcesStopped || 0} stopped</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-destructive">{execution.resourcesFailed || 0} failed</span>
                </div>
              </div>
            </div>
            {execution.errorMessage && (
              <div className="p-3 bg-destructive/10 text-red-700 rounded-md text-sm flex items-start space-x-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{execution.errorMessage}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Resource Details — one grid across all resource types, paginated */}
        <Card>
          <CardHeader>
            <CardTitle>Resource Details</CardTitle>
            <CardDescription>
              {totalResources} resource{totalResources === 1 ? "" : "s"} actioned in this execution
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResourceTable rows={allRows} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

type ResType = "ec2" | "rds" | "ecs" | "asg" | "docdb";
interface ResourceRow {
  res: any;
  type: ResType;
}

const RES_TYPE_LABEL: Record<ResType, string> = {
  ec2: "EC2",
  rds: "RDS",
  ecs: "ECS",
  asg: "ASG",
  docdb: "DocDB",
};

function resourceState(type: ResType, res: any): React.ReactNode {
  if (type === "ecs" && res.last_state) {
    return `Desired ${res.last_state.desiredCount} → Running ${res.last_state.runningCount}`;
  }
  if (type === "asg" && res.last_state) {
    return `Min ${res.last_state.minSize} / Max ${res.last_state.maxSize} / Desired ${res.last_state.desiredCapacity}`;
  }
  return <span className="text-muted-foreground/50">—</span>;
}

// One uniformly-aligned, paginated grid across every resource type (EC2/RDS/ECS/
// ASG/DocDB). Pagination is client-side — the rows come from the execution's
// in-memory metadata.
const RESOURCE_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function ResourceTable({ rows }: { rows: ResourceRow[] }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border py-10 text-center text-muted-foreground">
        <Info className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>No resources were started or stopped in this execution.</p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border overflow-x-auto">
        <Table className="min-w-[820px]">
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="min-w-[300px]">Resource</TableHead>
              <TableHead className="w-[80px]">Type</TableHead>
              <TableHead className="w-[90px]">Action</TableHead>
              <TableHead className="w-[200px]">State</TableHead>
              <TableHead className="w-[100px] text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map(({ res, type }, idx) => (
              <TableRow key={start + idx} className="align-top">
                <TableCell className="align-top">
                  <div className="space-y-0.5">
                    <div className="font-medium text-sm">
                      {res.resourceId || res.arn?.split("/").pop()}
                    </div>
                    {res.arn && (
                      <div className="flex items-center gap-1">
                        <span
                          className="block max-w-[420px] truncate font-mono text-xs text-muted-foreground"
                          title={res.arn}
                        >
                          {res.arn}
                        </span>
                        <CopyButton value={res.arn} label="Copy ARN" />
                      </div>
                    )}
                    {res.error && (
                      <div className="text-xs text-destructive">{res.error}</div>
                    )}
                  </div>
                </TableCell>
                <TableCell className="align-top">
                  <Badge variant="secondary" className="text-xs">
                    {RES_TYPE_LABEL[type]}
                  </Badge>
                </TableCell>
                <TableCell className="align-top">
                  <Badge variant="outline" className="text-xs capitalize">
                    {res.action}
                  </Badge>
                </TableCell>
                <TableCell className="align-top text-xs text-muted-foreground whitespace-nowrap">
                  {resourceState(type, res)}
                </TableCell>
                <TableCell className="align-top text-right">
                  {res.status === "success" ? (
                    <Badge className="bg-success/10 text-green-800 hover:bg-success/10">
                      Success
                    </Badge>
                  ) : (
                    <Badge variant="destructive">Failed</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <PaginationBar
        currentPage={currentPage}
        totalItems={rows.length}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
        pageSizeOptions={RESOURCE_PAGE_SIZE_OPTIONS}
        itemLabel="resources"
      />
    </div>
  );
}

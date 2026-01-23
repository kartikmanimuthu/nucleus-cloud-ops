"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  Calendar,
  Clock,
  MoreHorizontal,
  Edit,
  Trash2,
  Power,
  PowerOff,
  Loader2,
  Users,
  TrendingUp,
  Eye,
  Copy,
  Play,
} from "lucide-react";
import { DeleteScheduleDialog } from "./delete-schedule-dialog";
import { DuplicateScheduleDialog } from "./duplicate-schedule-dialog";
import { UISchedule } from "@/lib/types";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { formatDate } from "@/lib/date-utils";
import { useToast } from "@/hooks/use-toast";

interface SchedulesTableProps {
  schedules: UISchedule[];
  selectedSchedules: string[];
  onSelectAll: (checked: boolean) => void;
  onSelectSchedule: (scheduleId: string, checked: boolean) => void;
  onScheduleUpdated?: () => void;
}

export function SchedulesTable({
  schedules,
  selectedSchedules,
  onSelectAll,
  onSelectSchedule,
  onScheduleUpdated,
}: SchedulesTableProps) {
  const router = useRouter();
  const [deletingSchedule, setDeletingSchedule] = useState<UISchedule | null>(
    null
  );
  const [duplicatingSchedule, setDuplicatingSchedule] =
    useState<UISchedule | null>(null);
  const [loadingActions, setLoadingActions] = useState<string | null>(null);
  const { toast } = useToast();

  const allSelected =
    schedules.length > 0 && selectedSchedules.length === schedules.length;
  const someSelected =
    selectedSchedules.length > 0 && selectedSchedules.length < schedules.length;

  const toggleScheduleStatus = async (schedule: UISchedule) => {
    try {
      setLoadingActions(schedule.id);
      await ClientScheduleService.toggleScheduleStatus(schedule.id);
      if (onScheduleUpdated) {
        onScheduleUpdated();
      }
      toast({
        variant: "success",
        title: "Status Updated",
        description: `Schedule ${schedule.active ? "deactivated" : "activated"
          } successfully.`,
      });
    } catch (error: any) {
      console.error("Error toggling schedule status:", error);
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: error.message || "Failed to toggle schedule status.",
      });
    } finally {
      setLoadingActions(null);
    }
  };

  const executeScheduleNow = async (scheduleId: string) => {
    try {
      setLoadingActions(scheduleId);

      // Implement execute now functionality
      const response = await fetch(`/api/schedules/${scheduleId}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const result = await response.json();
        toast({
          title: "Schedule Executed",
          description: `Schedule has been executed successfully.`,
        });
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
      setLoadingActions(null);
    }
  };

  const deleteSchedule = async (schedule: UISchedule) => {
    // Just set the schedule to be deleted, the dialog will handle the rest
    setDeletingSchedule(schedule);
  };

  const getSuccessRateColor = (rate?: number) => {
    if (!rate) return "text-gray-600 dark:text-muted-foreground";
    if (rate >= 95) return "text-success dark:text-success";
    if (rate >= 85) return "text-warning dark:text-warning";
    return "text-destructive dark:text-destructive";
  };

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={onSelectAll}
                  aria-label="Select all schedules"
                  className={
                    someSelected ? "data-[state=checked]:bg-primary" : ""
                  }
                />
              </TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Time Window</TableHead>
              <TableHead>Days</TableHead>
              <TableHead>Targets</TableHead>
              <TableHead>Performance</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Next Run</TableHead>
              <TableHead className="w-[70px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules.map((schedule) => (
              <TableRow key={schedule.id} className="hover:bg-muted/50">
                <TableCell>
                  <Checkbox
                    checked={selectedSchedules.includes(schedule.id)}
                    onCheckedChange={(checked) =>
                      onSelectSchedule(schedule.id, checked as boolean)
                    }
                    aria-label={`Select ${schedule.name}`}
                  />
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <button
                      onClick={() => router.push(`/schedules/${encodeURIComponent(schedule.id)}`)}
                      className="font-medium text-left hover:text-primary hover:underline transition-colors cursor-pointer"
                    >
                      {schedule.name}
                    </button>
                    <div className="text-sm text-muted-foreground line-clamp-2">
                      {schedule.description || "No description"}
                    </div>
                    <div className="flex items-center space-x-2 text-xs text-muted-foreground">
                      <span>Created by {schedule.createdBy || "Unknown"}</span>
                      <span>•</span>
                      <span>
                        {schedule.createdAt
                          ? formatDate(schedule.createdAt)
                          : "Unknown date"}
                      </span>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <div className="flex items-center space-x-1">
                      <Clock className="h-3 w-3" />
                      <span className="text-sm font-mono">
                        {schedule.starttime} - {schedule.endtime}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {schedule.timezone}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {schedule.days.map((day: string) => (
                      <Badge key={day} variant="outline" className="text-xs">
                        {day}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="space-y-2">
                    <div className="flex items-center space-x-1">
                      <Users className="h-3 w-3" />
                      <span className="text-sm">
                        {schedule.accounts?.length || 0} accounts
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {schedule.resourceTypes?.map((type: string) => (
                        <Badge
                          key={type}
                          variant="secondary"
                          className="text-xs bg-info/10 text-blue-800"
                        >
                          {type}
                        </Badge>
                      )) || (
                          <span className="text-xs text-muted-foreground">
                            No resources
                          </span>
                        )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <div className="flex items-center space-x-1">
                      <TrendingUp className="h-3 w-3" />
                      <span
                        className={`text-sm font-medium ${getSuccessRateColor(
                          schedule.successRate
                        )}`}
                      >
                        {schedule.successRate
                          ? `${schedule.successRate}%`
                          : "N/A"}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {schedule.executionCount || 0} executions
                    </div>
                    <div className="text-xs text-success dark:text-success">
                      $
                      {schedule.estimatedSavings
                        ? schedule.estimatedSavings.toLocaleString()
                        : 0}
                      /month
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="space-y-2">
                    <Badge
                      variant={schedule.active ? "default" : "secondary"}
                      className={
                        schedule.active
                          ? "bg-success/10 text-green-800"
                          : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300"
                      }
                    >
                      {schedule.active ? "Active" : "Inactive"}
                    </Badge>
                    <div className="flex items-center space-x-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => toggleScheduleStatus(schedule)}
                        disabled={loadingActions === schedule.id}
                        className="h-8 px-2 text-xs"
                      >
                        {loadingActions === schedule.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <span className="mr-1">⚪</span>
                            {schedule.active ? "Deactivate" : "Activate"}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  {schedule.nextExecution ? (
                    <div className="text-sm">
                      <div>{formatDate(schedule.nextExecution)}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatDate(schedule.nextExecution, {
                          includeTime: true,
                        })}
                      </div>
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      Not scheduled
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" className="h-8 w-8 p-0">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() =>
                          router.push(
                            `/schedules/${encodeURIComponent(schedule.id)}`
                          )
                        }
                      >
                        <Eye className="mr-2 h-4 w-4" />
                        View Details
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          router.push(
                            `/schedules/${encodeURIComponent(
                              schedule.id
                            )}/edit`
                          )
                        }
                      >
                        <Edit className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setDuplicatingSchedule(schedule)}
                      >
                        <Copy className="mr-2 h-4 w-4" />
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => executeScheduleNow(schedule.id)}
                      >
                        <Play className="mr-2 h-4 w-4" />
                        Execute Now
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => deleteSchedule(schedule)}
                        className="text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {schedules.length === 0 && (
          <div className="text-center py-12">
            <Calendar className="mx-auto h-12 w-12 text-muted-foreground" />
            <h3 className="mt-2 text-sm font-semibold">No schedules found</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Try adjusting your search terms or filters, or create a new
              schedule.
            </p>
          </div>
        )}
      </CardContent>

      {/* Dialogs */}
      {duplicatingSchedule && (
        <DuplicateScheduleDialog
          schedule={duplicatingSchedule}
          open={!!duplicatingSchedule}
          onOpenChange={(open) => !open && setDuplicatingSchedule(null)}
          onScheduleDuplicated={() => {
            onScheduleUpdated?.();
          }}
        />
      )}
      {deletingSchedule && (
        <DeleteScheduleDialog
          schedule={deletingSchedule}
          open={!!deletingSchedule}
          onOpenChange={(open) => !open && setDeletingSchedule(null)}
          onDeleted={() => {
            // Call the parent's update function to refresh the schedules list
            onScheduleUpdated?.();
          }}
        />
      )}
    </Card>
  );
}

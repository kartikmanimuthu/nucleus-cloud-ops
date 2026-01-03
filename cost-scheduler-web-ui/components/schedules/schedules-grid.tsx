"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  Eye,
  Copy,
  Play,
  Users,
  TrendingUp,
  DollarSign,
} from "lucide-react";
import { DeleteScheduleDialog } from "./delete-schedule-dialog";
import { DuplicateScheduleDialog } from "./duplicate-schedule-dialog";
import { UISchedule } from "@/lib/types";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { formatDate } from "@/lib/date-utils";
import { useToast } from "@/hooks/use-toast";

interface SchedulesGridProps {
  schedules: UISchedule[];
  selectedSchedules: string[];
  onSelectSchedule: (scheduleId: string, checked: boolean) => void;
  onScheduleUpdated?: () => void;
}

export function SchedulesGrid({
  schedules,
  selectedSchedules,
  onSelectSchedule,
  onScheduleUpdated,
}: SchedulesGridProps) {
  const router = useRouter();
  const [deletingSchedule, setDeletingSchedule] = useState<UISchedule | null>(
    null
  );
  const [duplicatingSchedule, setDuplicatingSchedule] =
    useState<UISchedule | null>(null);
  const [loadingActions, setLoadingActions] = useState<string | null>(null);
  const { toast } = useToast();

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

  const deleteSchedule = async (schedule: UISchedule) => {
    if (
      !confirm(
        `Are you sure you want to delete schedule "${schedule.name}"? This action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      setDeletingSchedule(schedule);
      await ClientScheduleService.deleteSchedule(schedule.id);
      onScheduleUpdated?.();
      toast({
        variant: "success",
        title: "Schedule Deleted",
        description: `Schedule "${schedule.name}" deleted successfully.`,
      });
    } catch (error: any) {
      console.error("Error deleting schedule:", error);
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error.message || "Failed to delete schedule.",
      });
    } finally {
      setDeletingSchedule(null);
    }
  };

  const getSuccessRateColor = (rate?: number) => {
    if (!rate) return "text-gray-600 dark:text-muted-foreground";
    if (rate >= 95) return "text-success dark:text-success";
    if (rate >= 85) return "text-warning dark:text-warning";
    return "text-destructive dark:text-destructive";
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
        // Would need to add toast hook if not already available
        console.log("Schedule executed successfully");
      } else {
        throw new Error('Execution request failed');
      }

    } catch (error) {
      console.error("Error executing schedule:", error);
    } finally {
      setLoadingActions(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {schedules.map((schedule) => (
          <Card
            key={schedule.id}
            className="relative hover:shadow-md transition-shadow"
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={selectedSchedules.includes(schedule.id)}
                    onCheckedChange={(checked) =>
                      onSelectSchedule(schedule.id, checked as boolean)
                    }
                    aria-label={`Select ${schedule.name}`}
                  />
                </div>
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
                          `/schedules/${encodeURIComponent(schedule.id)}/edit`
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
                      onClick={() => setDeletingSchedule(schedule)}
                      className="text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>{" "}
              <div>
                <CardTitle className="text-lg">{schedule.name}</CardTitle>
                <CardDescription className="line-clamp-2">
                  {schedule.description || "No description"}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Time and Days */}
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-mono">
                    {schedule.starttime} - {schedule.endtime}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ({schedule.timezone})
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {schedule.days.map((day: string) => (
                    <Badge key={day} variant="outline" className="text-xs">
                      {day}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Targets */}
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    {schedule.accounts?.length || 0} AWS accounts
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

              {/* Performance Metrics */}
              <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                <div className="space-y-1">
                  <div className="flex items-center space-x-1">
                    <TrendingUp className="h-3 w-3" />
                    <span className="text-xs text-muted-foreground">
                      Success Rate
                    </span>
                  </div>
                  <div
                    className={`text-sm font-medium ${getSuccessRateColor(
                      schedule.successRate
                    )}`}
                  >
                    {schedule.successRate ? `${schedule.successRate}%` : "N/A"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {schedule.executionCount || 0} runs
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center space-x-1">
                    <DollarSign className="h-3 w-3" />
                    <span className="text-xs text-muted-foreground">
                      Est. Savings
                    </span>
                  </div>
                  <div className="text-sm font-medium text-success dark:text-success">
                    $
                    {schedule.estimatedSavings
                      ? schedule.estimatedSavings.toLocaleString()
                      : 0}
                  </div>
                  <div className="text-xs text-muted-foreground">per month</div>
                </div>
              </div>

              {/* Next Execution */}
              <div className="space-y-1">
                <div className="flex items-center space-x-1">
                  <Calendar className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">
                    Next Execution
                  </span>
                </div>
                {schedule.nextExecution ? (
                  <div className="text-sm">
                    {formatDate(schedule.nextExecution, { includeTime: true })}
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Not scheduled
                  </span>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-2 border-t">
                <div className="text-xs text-muted-foreground">
                  Created by{" "}
                  {schedule.createdBy
                    ? schedule.createdBy.split("@")[0]
                    : "Unknown"}
                </div>
                <div className="flex items-center justify-between">
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
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

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
        />
      )}
    </div>
  );
}

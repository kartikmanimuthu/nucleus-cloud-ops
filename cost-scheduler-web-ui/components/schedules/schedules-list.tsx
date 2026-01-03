"use client";

import { useState, useEffect } from "react";
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
import { Input } from "@/components/ui/input";
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
  Search,
  Play,
  Pause,
  Edit,
  Trash2,
  Clock,
  Calendar,
  Eye,
  Copy,
  Loader2,
} from "lucide-react";
import { DeleteScheduleDialog } from "./delete-schedule-dialog";
import { DuplicateScheduleDialog } from "./duplicate-schedule-dialog";
import { formatDate } from "@/lib/date-utils";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { UISchedule } from "@/lib/types";

export function SchedulesList({ schedules, loading, error }: { schedules: UISchedule[], loading: boolean, error: any }) {
  const router = useRouter();
  // const [schedules, setSchedules] = useState<UISchedule[]>([]);
  // const [loading, setLoading] = useState(true);
  // const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [deletingSchedule, setDeletingSchedule] = useState<UISchedule | null>(
    null
  );
  const [duplicatingSchedule, setDuplicatingSchedule] =
    useState<UISchedule | null>(null);

  // Load schedules from DynamoDB
  // const loadSchedules = async () => {
  //   try {
  //     setLoading(true);
  //     setError(null);
  //     const data = await ClientScheduleService.getSchedules();
  //     setSchedules(data);
  //   } catch (err: any) {
  //     setError(err.message || "Failed to load schedules");
  //     console.error("Error loading schedules:", err);
  //   } finally {
  //     setLoading(false);
  //   }
  // };

  // useEffect(() => {
  //   loadSchedules();
  // }, []);

  const filteredSchedules = schedules.filter(
    (schedule) =>
      schedule.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (schedule.description &&
        schedule.description.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  // const toggleScheduleStatus = async (scheduleName: string) => {
  //   try {
  //     await ClientScheduleService.toggleScheduleStatus(scheduleName);
  //     // Reload schedules to reflect the change
  //     await loadSchedules();
  //   } catch (err: any) {
  //     console.error("Error toggling schedule status:", err);
  //     setError(err.message || "Failed to toggle schedule status");
  //   }
  // };

  const executeScheduleNow = async (scheduleId: string) => {
    try {
      // Implement API call to execute schedule immediately
      const response = await fetch(`/api/schedules/${scheduleId}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const result = await response.json();
        console.log("schedule executed successfully");
      } else {
        throw new Error('Execution request failed');
      }

    } catch (error) {
      console.error("Error executing schedule:", error);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Cost Optimization Schedules</CardTitle>
            <CardDescription>
              Manage automated resource scheduling across AWS accounts
            </CardDescription>
          </div>
          <div className="flex items-center space-x-2">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search schedules..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8 w-[300px]"
              />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin" />
            <span className="ml-2">Loading schedules...</span>
          </div>
        ) : error ? (
          <div className="text-center py-8">
            <div className="text-red-500 mb-2">Failed to load schedules</div>
            <div className="text-sm text-muted-foreground mb-4">{error}</div>
            <Button onClick={() => {
              console.log(">> retrying");
            }} variant="outline">
              Try Again
            </Button>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Time Window</TableHead>
                  <TableHead>Days</TableHead>
                  <TableHead>Accounts</TableHead>
                  <TableHead>Resources</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Next Run</TableHead>
                  <TableHead className="w-[70px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSchedules.map((schedule) => (
                  <TableRow key={schedule.id}>
                    <TableCell>
                      <div>
                        <div className="font-medium">{schedule.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {schedule.description}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center space-x-1">
                        <Clock className="h-3 w-3" />
                        <span className="text-sm">
                          {schedule.starttime} - {schedule.endtime}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {schedule.timezone}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {schedule.days.map((day) => (
                          <Badge
                            key={day}
                            variant="outline"
                            className="text-xs"
                          >
                            {day}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        {schedule.accounts.length} account
                        {schedule.accounts.length !== 1 ? "s" : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {schedule.resourceTypes.map((type: string) => (
                          <Badge
                            key={type}
                            variant="secondary"
                            className="text-xs bg-blue-100 text-blue-800"
                          >
                            {type}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center space-x-2">
                        <Badge
                          variant={schedule.active ? "default" : "secondary"}
                          className={
                            schedule.active
                              ? "bg-green-100 text-green-800"
                              : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300"
                          }
                        >
                          {schedule.active ? "Active" : "Inactive"}
                        </Badge>
                        {/* <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleScheduleStatus(schedule.name)}
                        >
                          {schedule.active ? (
                            <Pause className="h-3 w-3" />
                          ) : (
                            <Play className="h-3 w-3" />
                          )}
                        </Button> */}
                      </div>
                    </TableCell>
                    <TableCell>
                      {schedule.nextExecution ? (
                        <div className="text-sm">
                          {formatDate(schedule.nextExecution)}
                          <br />
                          <span className="text-xs text-muted-foreground">
                            {formatDate(schedule.nextExecution, {
                              includeTime: true,
                            })}
                          </span>
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
                                `/schedules/${encodeURIComponent(
                                  schedule.id
                                )}`
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
                            onClick={() => setDeletingSchedule(schedule)}
                            className="text-red-600"
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

            {filteredSchedules.length === 0 && !loading && !error && (
              <div className="text-center py-8">
                <Calendar className="mx-auto h-12 w-12 text-muted-foreground" />
                <h3 className="mt-2 text-sm font-semibold text-gray-900">
                  No schedules found
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {searchTerm
                    ? "Try adjusting your search terms."
                    : "Get started by creating a new schedule."}
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>

      {/* Duplicate Dialog */}
      {duplicatingSchedule && (
        <DuplicateScheduleDialog
          schedule={duplicatingSchedule}
          open={!!duplicatingSchedule}
          onOpenChange={(open: boolean) =>
            !open && setDuplicatingSchedule(null)
          }
        />
      )}

      {/* Delete Dialog */}
      {deletingSchedule && (
        <DeleteScheduleDialog
          schedule={deletingSchedule}
          open={!!deletingSchedule}
          onOpenChange={(open: boolean) => !open && setDeletingSchedule(null)}
        />
      )}
    </Card>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Clock, Calendar, Save, Loader2 } from "lucide-react";
import { Schedule, UISchedule } from "@/lib/types";
import { ClientScheduleService } from "@/lib/client-schedule-service";

const scheduleFormSchema = z.object({
  name: z.string().min(1, "Schedule name is required"),
  starttime: z
    .string()
    .regex(/^\d{2}:\d{2}:\d{2}$/, "Start time must be in HH:MM:SS format"),
  endtime: z
    .string()
    .regex(/^\d{2}:\d{2}:\d{2}$/, "End time must be in HH:MM:SS format"),
  timezone: z.string().min(1, "Timezone is required"),
  active: z.boolean(),
  days: z.array(z.string()).min(1, "At least one day must be selected"),
});

type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

interface EditScheduleFormProps {
  schedule: UISchedule;
}

const DAYS_OF_WEEK = [
  { id: "Mon", label: "Monday" },
  { id: "Tue", label: "Tuesday" },
  { id: "Wed", label: "Wednesday" },
  { id: "Thu", label: "Thursday" },
  { id: "Fri", label: "Friday" },
  { id: "Sat", label: "Saturday" },
  { id: "Sun", label: "Sunday" },
];

const TIMEZONES = [
  { value: "Asia/Kolkata", label: "Asia/Kolkata (IST)" },
  { value: "America/New_York", label: "America/New_York (EST)" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (PST)" },
  { value: "Europe/London", label: "Europe/London (GMT)" },
  { value: "UTC", label: "UTC" },
];

export function EditScheduleForm({ schedule }: EditScheduleFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const form = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: {
      name: schedule.name,
      starttime: schedule.starttime,
      endtime: schedule.endtime,
      timezone: schedule.timezone,
      active: Boolean(schedule.active),
      days: schedule.days,
    },
  });

  const onSubmit = async (data: ScheduleFormValues) => {
    try {
      setLoading(true);

      // Create update payload excluding the name and type fields
      const updateData = {
        starttime: data.starttime,
        endtime: data.endtime,
        timezone: data.timezone,
        active: Boolean(data.active),
        days: data.days,
        // Don't include 'name' or 'type' as they are key attributes
      };

      // Update the schedule
      await ClientScheduleService.updateSchedule(schedule.id, updateData);

      // Redirect back to schedules list
      router.push("/app/schedules");
    } catch (error) {
      console.error("Failed to update schedule:", error);
      // TODO: Show error toast
    } finally {
      setLoading(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Basic Information */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Calendar className="h-5 w-5" />
              <span>Basic Information</span>
            </CardTitle>
            <CardDescription>
              Configure the basic schedule details
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Schedule Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Enter schedule name" disabled />
                  </FormControl>
                  <FormDescription>
                    A unique identifier for this schedule (cannot be changed)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Active Schedule</FormLabel>
                    <FormDescription>
                      Whether this schedule is currently active and will be used
                      for resource management
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value === true}
                      onCheckedChange={(checked) => {
                        field.onChange(checked === true);
                      }}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Time Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Clock className="h-5 w-5" />
              <span>Time Configuration</span>
            </CardTitle>
            <CardDescription>
              Set the operating hours for this schedule
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="starttime"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start Time</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="09:00:00" />
                    </FormControl>
                    <FormDescription>
                      Format: HH:MM:SS (24-hour)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="endtime"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End Time</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="18:00:00" />
                    </FormControl>
                    <FormDescription>
                      Format: HH:MM:SS (24-hour)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Timezone</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a timezone" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz.value} value={tz.value}>
                          {tz.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    The timezone for start and end times
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Days of Week */}
        <Card>
          <CardHeader>
            <CardTitle>Days of Week</CardTitle>
            <CardDescription>
              Select which days this schedule should be active
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={form.control}
              name="days"
              render={() => (
                <FormItem>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {DAYS_OF_WEEK.map((day) => (
                      <FormField
                        key={day.id}
                        control={form.control}
                        name="days"
                        render={({ field }) => {
                          return (
                            <FormItem
                              key={day.id}
                              className="flex flex-row items-start space-x-3 space-y-0"
                            >
                              <FormControl>
                                <Checkbox
                                  checked={field.value?.includes(day.id)}
                                  onCheckedChange={(checked) => {
                                    return checked
                                      ? field.onChange([...field.value, day.id])
                                      : field.onChange(
                                        field.value?.filter(
                                          (value) => value !== day.id
                                        )
                                      );
                                  }}
                                />
                              </FormControl>
                              <FormLabel className="text-sm font-normal">
                                {day.label}
                              </FormLabel>
                            </FormItem>
                          );
                        }}
                      />
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Preview */}
        <Card>
          <CardHeader>
            <CardTitle>Schedule Preview</CardTitle>
            <CardDescription>
              Review your schedule configuration
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center space-x-2">
                <Badge variant={form.watch("active") ? "default" : "secondary"}>
                  {form.watch("active") ? "Active" : "Inactive"}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {form.watch("name")}
                </span>
              </div>

              <div className="flex items-center space-x-4 text-sm">
                <div className="flex items-center space-x-2">
                  <Clock className="h-4 w-4" />
                  <span>
                    {form.watch("starttime")} - {form.watch("endtime")}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">
                    {form.watch("timezone")}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {form.watch("days")?.map((day) => (
                  <Badge key={day} variant="outline">
                    {DAYS_OF_WEEK.find((d) => d.id === day)?.label}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex items-center justify-end space-x-2">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Save className="mr-2 h-4 w-4" />
            Save Changes
          </Button>
        </div>
      </form>
    </Form>
  );
}

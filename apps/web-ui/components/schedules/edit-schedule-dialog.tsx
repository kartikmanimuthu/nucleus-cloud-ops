"use client";

import type React from "react";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Clock, Settings, Server, Loader2 } from "lucide-react";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { useToast } from "@/hooks/use-toast";

interface EditScheduleDialogProps {
  schedule: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const timezones = [
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Los_Angeles", label: "Pacific Time" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Asia/Tokyo", label: "Tokyo" },
];

const daysOfWeek = [
  { id: "Mon", label: "Monday" },
  { id: "Tue", label: "Tuesday" },
  { id: "Wed", label: "Wednesday" },
  { id: "Thu", label: "Thursday" },
  { id: "Fri", label: "Friday" },
  { id: "Sat", label: "Saturday" },
  { id: "Sun", label: "Sunday" },
];

const resourceTypes = [
  { id: "EC2", label: "EC2 Instances" },
  { id: "RDS", label: "RDS Databases" },
  { id: "ECS", label: "ECS Services" },
  { id: "ElastiCache", label: "ElastiCache Clusters" },
];

const mockAccounts = [
  { id: "acc-001", name: "Production Account", accountId: "123456789012" },
  { id: "acc-002", name: "Development Account", accountId: "123456789013" },
  { id: "acc-003", name: "Staging Account", accountId: "123456789014" },
];

export function EditScheduleDialog({
  schedule,
  open,
  onOpenChange,
}: EditScheduleDialogProps) {
  const { data: session } = useSession();
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    startTime: "",
    endTime: "",
    timezone: "UTC",
    daysOfWeek: [] as string[],
    accounts: [] as string[],
    resourceTypes: [] as string[],
    active: true,
    resourceTags: "",
    excludeTags: "",
    resources: [] as Array<{ id: string; type: string; name?: string; arn?: string }>,
  });

  const [isUpdating, setIsUpdating] = useState(false);

  const { toast } = useToast();

  useEffect(() => {
    if (schedule) {
      setFormData({
        name: schedule.name || "",
        description: schedule.description || "",
        startTime: schedule.starttime || "",
        endTime: schedule.endtime || "",
        timezone: schedule.timezone || "UTC",
        daysOfWeek: schedule.days || [],
        accounts: schedule.accounts || [],
        resourceTypes: schedule.resourceTypes || [],
        active: schedule.active ?? true,
        resourceTags: schedule.resourceTags || "",
        excludeTags: schedule.excludeTags || "",
        resources: schedule.resources || [],
      });
    }
  }, [schedule]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.daysOfWeek.length === 0) {
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: "Please select at least one day.",
      });
      return;
    }

    try {
      setIsUpdating(true);
      await ClientScheduleService.updateSchedule(schedule.id, {
        description: formData.description,
        starttime: formData.startTime,
        endtime: formData.endTime,
        timezone: formData.timezone,
        days: formData.daysOfWeek,
        active: formData.active,
        resources: formData.resources,
        updatedBy: session?.user?.email || "user", // Get from auth context
      });

      toast({
        variant: "success",
        title: "Schedule Updated",
        description: `Schedule "${schedule.name}" updated successfully.`,
      });

      onOpenChange(false);
      // Refresh the page to show the updated schedule
      window.location.reload();
    } catch (error: any) {
      console.error("Error updating schedule:", error);
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: error.message || "Failed to update schedule.",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDayToggle = (dayId: string) => {
    setFormData((prev) => ({
      ...prev,
      daysOfWeek: prev.daysOfWeek.includes(dayId)
        ? prev.daysOfWeek.filter((d) => d !== dayId)
        : [...prev.daysOfWeek, dayId],
    }));
  };

  const handleAccountToggle = (accountId: string) => {
    setFormData((prev) => ({
      ...prev,
      accounts: prev.accounts.includes(accountId)
        ? prev.accounts.filter((a) => a !== accountId)
        : [...prev.accounts, accountId],
    }));
  };

  const handleResourceTypeToggle = (resourceType: string) => {
    setFormData((prev) => ({
      ...prev,
      resourceTypes: prev.resourceTypes.includes(resourceType)
        ? prev.resourceTypes.filter((r) => r !== resourceType)
        : [...prev.resourceTypes, resourceType],
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Edit Schedule</DialogTitle>
          <DialogDescription>
            Update the configuration for "{schedule?.name}"
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <Tabs defaultValue="basic" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="basic">Basic Info</TabsTrigger>
              <TabsTrigger value="timing">Timing</TabsTrigger>
              <TabsTrigger value="targets">Targets</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Settings className="h-4 w-4" />
                    <span>Schedule Information</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Schedule Name *</Label>
                      <Input
                        id="name"
                        value={formData.name}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            name: e.target.value,
                          }))
                        }
                        placeholder="e.g., Production DB Shutdown"
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="active">Status</Label>
                      <div className="flex items-center space-x-2">
                        <Switch
                          id="active"
                          checked={formData.active}
                          onCheckedChange={(checked) =>
                            setFormData((prev) => ({
                              ...prev,
                              active: checked,
                            }))
                          }
                        />
                        <Label htmlFor="active">
                          {formData.active ? "Active" : "Inactive"}
                        </Label>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          description: e.target.value,
                        }))
                      }
                      placeholder="Describe what this schedule does..."
                      rows={3}
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="timing" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Clock className="h-4 w-4" />
                    <span>Schedule Timing</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="startTime">Start Time *</Label>
                      <Input
                        id="startTime"
                        type="time"
                        value={formData.startTime}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            startTime: e.target.value,
                          }))
                        }
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="endTime">End Time *</Label>
                      <Input
                        id="endTime"
                        type="time"
                        value={formData.endTime}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            endTime: e.target.value,
                          }))
                        }
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="timezone">Timezone *</Label>
                      <Select
                        value={formData.timezone}
                        onValueChange={(value) =>
                          setFormData((prev) => ({ ...prev, timezone: value }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {timezones.map((tz) => (
                            <SelectItem key={tz.value} value={tz.value}>
                              {tz.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Days of Week *</Label>
                    <div className="grid grid-cols-4 gap-2">
                      {daysOfWeek.map((day) => (
                        <div
                          key={day.id}
                          className="flex items-center space-x-2"
                        >
                          <Checkbox
                            id={day.id}
                            checked={formData.daysOfWeek.includes(day.id)}
                            onCheckedChange={() => handleDayToggle(day.id)}
                          />
                          <Label htmlFor={day.id} className="text-sm">
                            {day.label}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="targets" className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <Server className="h-4 w-4" />
                      <span>AWS Accounts</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {mockAccounts.map((account) => (
                      <div
                        key={account.id}
                        className="flex items-center space-x-2"
                      >
                        <Checkbox
                          id={account.id}
                          checked={formData.accounts.includes(account.id)}
                          onCheckedChange={() =>
                            handleAccountToggle(account.id)
                          }
                        />
                        <Label htmlFor={account.id} className="flex-1">
                          <div className="font-medium">{account.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {account.accountId}
                          </div>
                        </Label>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Resource Types</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {resourceTypes.map((resource) => (
                      <div
                        key={resource.id}
                        className="flex items-center space-x-2"
                      >
                        <Checkbox
                          id={resource.id}
                          checked={formData.resourceTypes.includes(resource.id)}
                          onCheckedChange={() =>
                            handleResourceTypeToggle(resource.id)
                          }
                        />
                        <Label htmlFor={resource.id}>{resource.label}</Label>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="advanced" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Advanced Filtering</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="resourceTags">
                      Include Resources with Tags
                    </Label>
                    <Input
                      id="resourceTags"
                      value={formData.resourceTags}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          resourceTags: e.target.value,
                        }))
                      }
                      placeholder="e.g., Environment=dev,Team=backend"
                    />
                    <p className="text-xs text-muted-foreground">
                      Comma-separated key=value pairs. Only resources with these
                      tags will be affected.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="excludeTags">
                      Exclude Resources with Tags
                    </Label>
                    <Input
                      id="excludeTags"
                      value={formData.excludeTags}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          excludeTags: e.target.value,
                        }))
                      }
                      placeholder="e.g., Critical=true,AlwaysOn=true"
                    />
                    <p className="text-xs text-muted-foreground">
                      Resources with these tags will be excluded from the
                      schedule.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isUpdating}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isUpdating}>
              {isUpdating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                "Update Schedule"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

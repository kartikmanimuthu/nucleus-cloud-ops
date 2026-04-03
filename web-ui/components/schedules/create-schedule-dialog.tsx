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
import { Clock, Server, Settings, Loader2 } from "lucide-react";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { useToast } from "@/hooks/use-toast";

interface CreateScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScheduleCreated?: () => void;
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

export function CreateScheduleDialog({
  open,
  onOpenChange,
  onScheduleCreated,
}: CreateScheduleDialogProps) {
  const { data: session } = useSession();
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    startTime: "",
    endTime: "",
    timezone: "UTC",
    daysOfWeek: [] as string[],
    accountId: "",
    resourceTypes: [] as string[],
    active: true,
    resourceTags: "",
    excludeTags: "",
  });

  const [accounts, setAccounts] = useState<
    { id: string; name: string; accountId: string }[]
  >([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const { toast } = useToast();

  // Fetch tenant-scoped accounts when dialog opens
  useEffect(() => {
    if (!open) return;
    setLoadingAccounts(true);
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((res) => {
        if (res.success) {
          setAccounts(
            res.data.map((a: { accountId: string; name: string }) => ({
              id: a.accountId,
              name: a.name,
              accountId: a.accountId,
            }))
          );
        }
      })
      .catch(console.error)
      .finally(() => setLoadingAccounts(false));
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (
      !formData.name ||
      !formData.startTime ||
      !formData.endTime ||
      formData.daysOfWeek.length === 0
    ) {
      alert("Please fill in all required fields");
      return;
    }

    if (!formData.accountId) {
      alert("Please select an AWS account");
      return;
    }

    try {
      setIsCreating(true);
      await ClientScheduleService.createSchedule({
        name: formData.name,
        description: formData.description,
        starttime: formData.startTime,
        endtime: formData.endTime,
        timezone: formData.timezone,
        days: formData.daysOfWeek,
        active: formData.active,
        accountId: formData.accountId,
        createdBy: session?.user?.email || "user",
        updatedBy: session?.user?.email || "user",
      });

      toast({
        variant: "success",
        title: "Schedule Created",
        description: `Schedule "${formData.name}" created successfully.`,
      });

      onOpenChange(false);
      // Reset form
      setFormData({
        name: "",
        description: "",
        startTime: "",
        endTime: "",
        timezone: "UTC",
        daysOfWeek: [],
        accountId: "",
        resourceTypes: [],
        active: true,
        resourceTags: "",
        excludeTags: "",
      });

      if (onScheduleCreated) {
        onScheduleCreated();
      }

      // Refresh the page to show the new schedule
      window.location.reload();
    } catch (error: any) {
      console.error("Error creating schedule:", error);
      toast({
        variant: "destructive",
        title: "Creation Failed",
        description: error.message || "Failed to create schedule.",
      });
    } finally {
      setIsCreating(false);
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
          <DialogTitle>Create New Schedule</DialogTitle>
          <DialogDescription>
            Configure a new cost optimization schedule for your AWS resources
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
                      <span>AWS Account *</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Select
                      value={formData.accountId}
                      onValueChange={(value) =>
                        setFormData((prev) => ({ ...prev, accountId: value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={
                            loadingAccounts
                              ? "Loading accounts..."
                              : "Select an account"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {!loadingAccounts && accounts.length === 0 && (
                          <SelectItem value="_none" disabled>
                            No accounts found
                          </SelectItem>
                        )}
                        {accounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            <div>
                              <div className="font-medium">{account.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {account.accountId}
                              </div>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isCreating}>
              {isCreating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Schedule"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

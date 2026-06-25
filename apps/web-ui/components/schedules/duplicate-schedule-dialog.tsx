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
import { Switch } from "@/components/ui/switch";
import { Copy, Loader2 } from "lucide-react";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { useToast } from "@/hooks/use-toast";

interface DuplicateScheduleDialogProps {
  schedule: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScheduleDuplicated?: () => void;
}

export function DuplicateScheduleDialog({
  schedule,
  open,
  onOpenChange,
  onScheduleDuplicated,
}: DuplicateScheduleDialogProps) {
  const { data: session } = useSession();
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    active: false,
  });

  const [isDuplicating, setIsDuplicating] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (schedule) {
      setFormData({
        name: `${schedule.name} (Copy)`,
        description: schedule.description,
        active: false, // Start duplicated schedules as inactive
      });
    }
  }, [schedule]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!schedule?.name || !formData.name) return;

    try {
      setIsDuplicating(true);
      await ClientScheduleService.createSchedule({
        name: formData.name,
        description: formData.description,
        starttime: schedule.starttime,
        endtime: schedule.endtime,
        timezone: schedule.timezone,
        days: schedule.days,
        active: formData.active,
        createdBy: session?.user?.email || "user",
        updatedBy: "user",
        // Pass accountId and resources
        accountId: schedule.accounts?.[0] || schedule.accountId,
        resources: schedule.resources,
      });

      onOpenChange(false);
      toast({
        variant: "success",
        title: "Schedule Duplicated",
        description: `Schedule "${formData.name}" created successfully.`,
      });
      // Call the callback to refresh the parent list
      if (onScheduleDuplicated) {
        onScheduleDuplicated();
      }
    } catch (error: any) {
      console.error("Error duplicating schedule:", error);
      toast({
        variant: "destructive",
        title: "Duplication Failed",
        description: error.message || "Failed to duplicate schedule.",
      });
    } finally {
      setIsDuplicating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <Copy className="h-5 w-5" />
            <span>Duplicate Schedule</span>
          </DialogTitle>
          <DialogDescription>
            Create a copy of "{schedule?.name}" with customizable settings.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Schedule Name *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, name: e.target.value }))
              }
              placeholder="Enter schedule name"
              required
            />
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
              placeholder="Enter schedule description"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="active">Initial Status</Label>
            <div className="flex items-center space-x-2">
              <Switch
                id="active"
                checked={formData.active}
                onCheckedChange={(checked) =>
                  setFormData((prev) => ({ ...prev, active: checked }))
                }
              />
              <Label htmlFor="active">
                {formData.active ? "Active" : "Inactive"}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Duplicated schedules start as inactive by default for safety.
            </p>
          </div>

          <div className="bg-muted p-3 rounded-lg">
            <p className="text-sm text-muted-foreground">
              <strong>Note:</strong> All other settings (timing, targets,
              filters) will be copied exactly from the original schedule. You
              can edit these after creation.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isDuplicating}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isDuplicating}>
              {isDuplicating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Duplicating...
                </>
              ) : (
                <>
                  <Copy className="mr-2 h-4 w-4" />
                  Duplicate Schedule
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

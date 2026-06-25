"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2 } from "lucide-react";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { useToast } from "@/hooks/use-toast";

interface DeleteScheduleDialogProps {
  schedule: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}

export function DeleteScheduleDialog({
  schedule,
  open,
  onOpenChange,
  onDeleted,
}: DeleteScheduleDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const { toast } = useToast();

  const handleDelete = async () => {
    if (!schedule?.name) return;

    try {
      setIsDeleting(true);
      await ClientScheduleService.deleteSchedule(schedule.id);
      
      toast({
        variant: "success",
        title: "Schedule Deleted",
        description: `Schedule "${schedule.name}" deleted successfully.`,
      });
      
      // Close the dialog
      onOpenChange(false);
      
      // Notify parent component that schedule was deleted
      if (onDeleted) {
        onDeleted();
      }
    } catch (error: any) {
      console.error("Error deleting schedule:", error);
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error.message || "Failed to delete schedule.",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <span>Delete Schedule</span>
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to delete "{schedule?.name}"? This action
            cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <div className="bg-destructive/10 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-800">
              <strong>Warning:</strong> Deleting this schedule will:
            </p>
            <ul className="text-sm text-red-700 mt-2 ml-4 list-disc">
              <li>Remove all future executions</li>
              <li>Stop any automated cost optimization</li>
              <li>Cannot be recovered once deleted</li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete Schedule"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Copy, Loader2 } from "lucide-react";
import { useCreateSchedule } from "@/lib/queries/schedules";
import { useToast } from "@/hooks/use-toast";

const duplicateScheduleSchema = z.object({
  name: z.string().min(1, "Schedule name is required"),
  description: z.string().optional(),
  active: z.boolean(),
});

type DuplicateScheduleValues = z.infer<typeof duplicateScheduleSchema>;

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
  const { toast } = useToast();
  const createSchedule = useCreateSchedule();

  const form = useForm<DuplicateScheduleValues>({
    resolver: zodResolver(duplicateScheduleSchema),
    defaultValues: { name: "", description: "", active: false },
  });

  // Reset the form whenever the source schedule changes.
  useEffect(() => {
    if (schedule) {
      form.reset({
        name: `${schedule.name} (Copy)`,
        description: schedule.description ?? "",
        active: false, // duplicated schedules start inactive for safety
      });
    }
  }, [schedule, form]);

  const onSubmit = async (values: DuplicateScheduleValues) => {
    if (!schedule?.name) return;

    try {
      // useCreateSchedule invalidates the schedules cache on success, so the
      // list refreshes automatically.
      await createSchedule.mutateAsync({
        name: values.name,
        description: values.description ?? "",
        starttime: schedule.starttime,
        endtime: schedule.endtime,
        timezone: schedule.timezone,
        days: schedule.days,
        active: values.active,
        createdBy: session?.user?.email || "user",
        updatedBy: "user",
        accountId: schedule.accounts?.[0] || schedule.accountId,
        resources: schedule.resources,
      });

      onOpenChange(false);
      toast({
        variant: "success",
        title: "Schedule Duplicated",
        description: `Schedule "${values.name}" created successfully.`,
      });
      onScheduleDuplicated?.();
    } catch (error: any) {
      console.error("Error duplicating schedule:", error);
      toast({
        variant: "destructive",
        title: "Duplication Failed",
        description: error?.message || "Failed to duplicate schedule.",
      });
    }
  };

  const isDuplicating = createSchedule.isPending;

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

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Schedule Name *</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter schedule name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Enter schedule description"
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Initial Status</FormLabel>
                  <div className="flex items-center space-x-2">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <span className="text-sm">{field.value ? "Active" : "Inactive"}</span>
                  </div>
                  <FormDescription>
                    Duplicated schedules start as inactive by default for safety.
                  </FormDescription>
                </FormItem>
              )}
            />

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
        </Form>
      </DialogContent>
    </Dialog>
  );
}

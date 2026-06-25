"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, Loader2 } from "lucide-react";
import { ScheduleForm } from "@/components/schedule-form";
import { ClientScheduleService } from "@/lib/client-schedule-service";
import { UISchedule } from "@/lib/types";

export default function EditSchedulePage({ params }: { params: Promise<{ scheduleId: string }> }) {
  const router = useRouter();
  const { scheduleId } = use(params);
  const [schedule, setSchedule] = useState<UISchedule | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSchedule() {
      try {
        const decodedId = decodeURIComponent(scheduleId);
        const data = await ClientScheduleService.getSchedule(decodedId);
        if (data) {
          setSchedule(data);
        } else {
            // Handle not found
            // router.push("/schedules");
        }
      } catch (error) {
        console.error("Failed to fetch schedule:", error);
      } finally {
        setLoading(false);
      }
    }
    fetchSchedule();
  }, [scheduleId]);

  if (loading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!schedule) {
    return <div>Schedule not found</div>;
  }

  return (
    <div className="container mx-auto py-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-4">
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Edit Schedule</h1>
            <p className="text-muted-foreground">
              Modify the schedule "{schedule.name}"
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Schedule Configuration</CardTitle>
          <CardDescription>
            Update the schedule settings and time configurations
          </CardDescription>
        </CardHeader>
        <CardContent>
           <ScheduleForm initialData={schedule} isEditing={true} />
        </CardContent>
      </Card>
    </div>
  );
}

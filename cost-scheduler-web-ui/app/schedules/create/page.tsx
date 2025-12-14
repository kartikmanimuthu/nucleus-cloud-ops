"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { ScheduleForm } from "@/components/schedule-form";

export default function CreateSchedulePage() {
  const router = useRouter();

  return (
    <div className="container mx-auto py-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-4">
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Create Schedule</h1>
            <p className="text-muted-foreground">
              Create a new cost optimization schedule
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Schedule Configuration</CardTitle>
          <CardDescription>
            Configure the schedule settings and time configurations
          </CardDescription>
        </CardHeader>
        <CardContent>
           <ScheduleForm />
        </CardContent>
      </Card>
    </div>
  );
}

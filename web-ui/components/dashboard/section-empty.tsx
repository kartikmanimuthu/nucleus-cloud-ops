"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Inbox } from "lucide-react";

interface SectionEmptyProps {
  title: string;
  message?: string;
}

export function SectionEmpty({ title, message }: SectionEmptyProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Inbox className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">
            {message || "No data available for the selected time range."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

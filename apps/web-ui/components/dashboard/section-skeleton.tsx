"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface SectionSkeletonProps {
  title: string;
  chartCount?: number;
}

export function SectionSkeleton({ title, chartCount = 2 }: SectionSkeletonProps) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={`grid gap-4 ${chartCount > 1 ? 'md:grid-cols-2' : ''}`}>
          {Array.from({ length: chartCount }).map((_, i) => (
            <Skeleton key={i} className="h-[300px] w-full rounded-lg" />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

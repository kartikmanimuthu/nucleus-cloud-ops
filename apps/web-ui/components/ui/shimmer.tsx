"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

interface ShimmerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Width of the shimmer - can be any CSS width value */
  width?: string;
  /** Height of the shimmer - defaults to "1rem" */
  height?: string;
  /** Whether to use rounded corners */
  rounded?: boolean;
}

/**
 * Shimmer component for loading states with animated gradient effect.
 * Used during streaming content to indicate loading.
 */
const Shimmer = React.forwardRef<HTMLDivElement, ShimmerProps>(
  ({ className, width = "100%", height = "1rem", rounded = true, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "animate-shimmer bg-gradient-to-r from-muted via-muted/50 to-muted bg-[length:200%_100%]",
        rounded && "rounded-md",
        className
      )}
      style={{ width, height }}
      {...props}
    />
  )
);
Shimmer.displayName = "Shimmer";

interface ShimmerLineProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of shimmer lines to render */
  lines?: number;
  /** Gap between lines */
  gap?: string;
}

/**
 * Multiple shimmer lines for text loading states.
 */
const ShimmerLines = React.forwardRef<HTMLDivElement, ShimmerLineProps>(
  ({ className, lines = 3, gap = "0.5rem", ...props }, ref) => (
    <div
      ref={ref}
      className={cn("space-y-2", className)}
      style={{ gap }}
      {...props}
    >
      {Array.from({ length: lines }).map((_, i) => (
        <Shimmer
          key={i}
          width={i === lines - 1 ? "60%" : "100%"}
          height="0.875rem"
        />
      ))}
    </div>
  )
);
ShimmerLines.displayName = "ShimmerLines";

/**
 * Shimmer block for larger content areas.
 */
const ShimmerBlock = React.forwardRef<HTMLDivElement, ShimmerProps>(
  ({ className, height = "4rem", ...props }, ref) => (
    <Shimmer
      ref={ref}
      className={cn("w-full", className)}
      height={height}
      {...props}
    />
  )
);
ShimmerBlock.displayName = "ShimmerBlock";

export { Shimmer, ShimmerLines, ShimmerBlock };

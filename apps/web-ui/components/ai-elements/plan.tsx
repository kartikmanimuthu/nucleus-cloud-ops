"use client"

import * as React from "react"
import { Check, Circle, Loader2, ChevronDown, ListChecks } from "lucide-react"
import { cn } from "@/lib/utils"
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import { ShimmerLines } from "@/components/ui/shimmer"

export type PlanStepStatus = 'pending' | 'active' | 'completed' | 'failed';

interface PlanContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  isStreaming: boolean;
}

const PlanContext = React.createContext<PlanContextValue | undefined>(undefined);

interface PlanProps extends Omit<React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>, 'defaultOpen'> {
  /** Whether content is currently streaming */
  isStreaming?: boolean;
  /** Whether to start open - defaults to true */
  defaultOpen?: boolean;
}

/**
 * Plan component for displaying AI-generated execution plans.
 * Features collapsible content with shimmer animations during streaming.
 */
const Plan = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Root>,
  PlanProps
>(({ className, defaultOpen = true, isStreaming = false, ...props }, ref) => {
  const [open, setOpen] = React.useState(defaultOpen);

  // Auto-open when streaming starts
  React.useEffect(() => {
    if (isStreaming) {
      setOpen(true);
    }
  }, [isStreaming]);

  return (
    <PlanContext.Provider value={{ open, setOpen, isStreaming }}>
      <CollapsiblePrimitive.Root
        ref={ref}
        open={open}
        onOpenChange={setOpen}
        className={cn(
          "w-full rounded-lg border bg-card shadow-sm overflow-hidden",
          isStreaming && "border-primary/30",
          className
        )}
        {...props}
      />
    </PlanContext.Provider>
  );
});
Plan.displayName = "Plan";

interface PlanHeaderProps extends React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleTrigger> {
  /** Title for the plan */
  title?: string;
  /** Optional icon to override default */
  icon?: React.ReactNode;
}

/**
 * Clickable header that toggles plan visibility.
 */
const PlanHeader = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleTrigger>,
  PlanHeaderProps
>(({ className, title = "Execution Plan", icon, ...props }, ref) => {
  const context = React.useContext(PlanContext);

  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      ref={ref}
      className={cn(
        "flex w-full items-center gap-3 px-4 py-3 text-sm font-medium transition-colors",
        "hover:bg-muted/50 bg-muted/20",
        "[&[data-state=open]>svg.chevron]:rotate-180",
        className
      )}
      {...props}
    >
      {icon || <ListChecks className="h-4 w-4 text-primary" />}
      <span className="flex-1 text-left font-semibold">{title}</span>
      {context?.isStreaming && (
        <span className="text-xs text-primary bg-primary/10 px-2 py-0.5 rounded-full animate-pulse">
          Generating...
        </span>
      )}
      <ChevronDown className="chevron h-4 w-4 text-muted-foreground transition-transform duration-200" />
    </CollapsiblePrimitive.CollapsibleTrigger>
  );
});
PlanHeader.displayName = "PlanHeader";

/**
 * Collapsible content area for plan steps.
 */
const PlanContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(({ className, children, ...props }, ref) => {
  const context = React.useContext(PlanContext);

  return (
    <CollapsiblePrimitive.CollapsibleContent
      ref={ref}
      className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
      {...props}
    >
      <div className={cn("border-t px-4 py-3 space-y-1", className)}>
        {children}
        {context?.isStreaming && (
          <ShimmerLines lines={2} className="mt-2" />
        )}
      </div>
    </CollapsiblePrimitive.CollapsibleContent>
  );
});
PlanContent.displayName = "PlanContent";

interface PlanStepProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Step number (1-indexed) */
  number?: number;
  /** Current status of the step */
  status?: PlanStepStatus;
  /** Step description */
  children: React.ReactNode;
}

/**
 * Individual step within a plan with status indicator.
 */
const PlanStep = React.forwardRef<HTMLDivElement, PlanStepProps>(
  ({ className, number, status = 'pending', children, ...props }, ref) => {
    const statusConfig = {
      pending: {
        icon: <Circle className="h-4 w-4 text-muted-foreground/50" />,
        textClass: "text-muted-foreground",
      },
      active: {
        icon: <Loader2 className="h-4 w-4 text-primary animate-spin" />,
        textClass: "text-foreground font-medium",
      },
      completed: {
        icon: <Check className="h-4 w-4 text-success" />,
        textClass: "text-muted-foreground",
      },
      failed: {
        icon: <Circle className="h-4 w-4 text-destructive" />,
        textClass: "text-destructive",
      },
    };

    const config = statusConfig[status];

    return (
      <div
        ref={ref}
        className={cn(
          "flex items-start gap-3 py-1.5 text-sm transition-colors",
          config.textClass,
          status === 'active' && "bg-primary/5 -mx-4 px-4 rounded-md",
          className
        )}
        {...props}
      >
        <span className="flex-shrink-0 mt-0.5">{config.icon}</span>
        <span className="flex-1">
          {number !== undefined && (
            <span className="font-mono text-xs text-muted-foreground/70 mr-2">
              {number}.
            </span>
          )}
          {children}
        </span>
      </div>
    );
  }
);
PlanStep.displayName = "PlanStep";

/**
 * Footer for plan actions (optional).
 */
const PlanFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("border-t px-4 py-2 bg-muted/10", className)}
    {...props}
  />
));
PlanFooter.displayName = "PlanFooter";

export { Plan, PlanHeader, PlanContent, PlanStep, PlanFooter };

"use client"

import * as React from "react"
import { ChevronDown, Terminal, Loader2, Check, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import { Shimmer, ShimmerLines } from "@/components/ui/shimmer"

export type ToolState = 'pending' | 'running' | 'complete' | 'error';

interface ToolContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  state: ToolState;
}

const ToolContext = React.createContext<ToolContextValue | undefined>(undefined);

interface ToolProps extends Omit<React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>, 'defaultOpen'> {
  /** Current state of the tool execution */
  state?: ToolState;
  /** Whether to start open - defaults to false */
  defaultOpen?: boolean;
}

/**
 * Tool component for displaying tool invocations in AI chat interfaces.
 * Features collapsible input/output sections with status indicators.
 */
const Tool = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Root>,
  ToolProps
>(({ className, defaultOpen = false, state = 'pending', ...props }, ref) => {
  const [open, setOpen] = React.useState(defaultOpen);

  // Sync with defaultOpen when it changes
  React.useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  return (
    <ToolContext.Provider value={{ open, setOpen, state }}>
      <CollapsiblePrimitive.Root
        ref={ref}
        open={open}
        onOpenChange={setOpen}
        className={cn(
          "w-full rounded-lg border bg-card shadow-sm overflow-hidden",
          state === 'running' && "border-primary/30",
          state === 'error' && "border-destructive/30",
          state === 'complete' && "border-success/30",
          className
        )}
        {...props}
      />
    </ToolContext.Provider>
  );
});
Tool.displayName = "Tool";

interface ToolHeaderProps extends Omit<React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleTrigger>, 'type'> {
  /** Name of the tool being invoked */
  toolName?: string;
  /** Tool type for display */
  type?: string;
  /** Current state - overrides context if provided */
  state?: ToolState;
  /** Whether tool was auto-approved */
  isAuto?: boolean;
}

/**
 * Clickable header with tool name and status indicator.
 */
const ToolHeader = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleTrigger>,
  ToolHeaderProps
>(({ className, toolName, type, state: stateProp, isAuto = false, ...props }, ref) => {
  const context = React.useContext(ToolContext);
  const state = stateProp ?? context?.state ?? 'pending';

  const stateConfig = {
    pending: {
      icon: <Terminal className="h-3.5 w-3.5" />,
      badge: null,
      iconBg: "bg-muted text-muted-foreground",
    },
    running: {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
      badge: <span className="text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded-full animate-pulse">Running</span>,
      iconBg: "bg-primary/10 text-primary border-primary/20",
    },
    complete: {
      icon: <Check className="h-3.5 w-3.5" />,
      badge: <span className="text-[10px] text-success bg-success/10 px-1.5 py-0.5 rounded-full">Complete</span>,
      iconBg: "bg-success/10 text-success border-success/20",
    },
    error: {
      icon: <AlertCircle className="h-3.5 w-3.5" />,
      badge: <span className="text-[10px] text-destructive bg-destructive/10 px-1.5 py-0.5 rounded-full">Error</span>,
      iconBg: "bg-destructive/10 text-destructive border-destructive/20",
    },
  };

  const config = stateConfig[state];
  const displayName = toolName || type?.replace('tool-', '').replace(/_/g, ' ') || 'Tool Execution';

  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      ref={ref}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2.5 text-sm transition-colors",
        "hover:bg-muted/50 bg-muted/20",
        "[&[data-state=open]>svg.chevron]:rotate-180",
        className
      )}
      {...props}
    >
      <div className={cn(
        "flex h-6 w-6 items-center justify-center rounded-full border",
        config.iconBg
      )}>
        {config.icon}
      </div>
      <span className="font-semibold text-xs tracking-tight uppercase flex-1 text-left">
        {displayName}
      </span>
      {isAuto && (
        <span className="text-[10px] text-success bg-success/10 px-1.5 py-0.5 rounded-full font-medium">
          AUTO
        </span>
      )}
      {config.badge}
      <ChevronDown className="chevron h-4 w-4 text-muted-foreground transition-transform duration-200" />
    </CollapsiblePrimitive.CollapsibleTrigger>
  );
});
ToolHeader.displayName = "ToolHeader";

/**
 * Collapsible content area for tool input/output.
 */
const ToolContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(({ className, children, ...props }, ref) => (
  <CollapsiblePrimitive.CollapsibleContent
    ref={ref}
    className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
    {...props}
  >
    <div className={cn("border-t divide-y", className)}>
      {children}
    </div>
  </CollapsiblePrimitive.CollapsibleContent>
));
ToolContent.displayName = "ToolContent";

interface ToolInputProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Input data to display */
  input?: any;
  /** Label for the input section */
  label?: string;
}

/**
 * Displays tool input/arguments in a formatted code block.
 */
const ToolInput = React.forwardRef<HTMLDivElement, ToolInputProps>(
  ({ className, input, label = "Input", ...props }, ref) => {
    const formattedInput = typeof input === 'string' ? input : JSON.stringify(input, null, 2);

    return (
      <div ref={ref} className={cn("px-3 py-2", className)} {...props}>
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
          {label}
        </div>
        <pre className="font-mono text-[11px] whitespace-pre-wrap break-all bg-muted/30 rounded-md p-2 max-h-40 overflow-y-auto">
          <code>{formattedInput}</code>
        </pre>
      </div>
    );
  }
);
ToolInput.displayName = "ToolInput";

interface ToolOutputProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Output data to display */
  output?: any;
  /** Error text if tool failed */
  errorText?: string;
  /** Whether output is still loading */
  isLoading?: boolean;
  /** Label for the output section */
  label?: string;
}

/**
 * Displays tool output/result with loading and error states.
 */
const ToolOutput = React.forwardRef<HTMLDivElement, ToolOutputProps>(
  ({ className, output, errorText, isLoading = false, label = "Output", ...props }, ref) => {
    const context = React.useContext(ToolContext);
    const showLoading = isLoading || context?.state === 'running';

    if (!output && !showLoading && !errorText) return null;

    const formattedOutput = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

    return (
      <div ref={ref} className={cn("px-3 py-2", className)} {...props}>
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
          {label}
        </div>
        {showLoading ? (
          <div className="space-y-2">
            <ShimmerLines lines={3} />
          </div>
        ) : errorText ? (
          <div className="font-mono text-[11px] text-destructive bg-destructive/10 rounded-md p-2">
            {errorText}
          </div>
        ) : (
          <pre className="font-mono text-[11px] whitespace-pre-wrap break-all bg-muted/30 rounded-md p-2 max-h-60 overflow-y-auto">
            <code>{formattedOutput}</code>
          </pre>
        )}
      </div>
    );
  }
);
ToolOutput.displayName = "ToolOutput";

// Keep old exports for backwards compatibility
const ToolTrigger = ToolHeader;

export { Tool, ToolHeader, ToolTrigger, ToolContent, ToolInput, ToolOutput };

"use client"

import * as React from "react"
import { ChevronDown, Brain, Clock } from "lucide-react"
import { cn } from "@/lib/utils"
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import { MarkdownContent } from "@/components/ui/markdown-content"

interface ReasoningContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  isStreaming: boolean;
}

const ReasoningContext = React.createContext<ReasoningContextValue | undefined>(undefined);

interface ReasoningProps extends Omit<React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>, 'defaultOpen'> {
  /** Whether content is currently streaming */
  isStreaming?: boolean;
  /** Whether to start open - defaults based on streaming state */
  defaultOpen?: boolean;
}

/**
 * Reasoning component for displaying AI thinking/reasoning content.
 * Auto-opens during streaming and can auto-close when complete.
 */
const Reasoning = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Root>,
  ReasoningProps
>(({ className, defaultOpen, isStreaming = false, ...props }, ref) => {
  const [open, setOpen] = React.useState(defaultOpen ?? isStreaming);
  const [startTime] = React.useState<number>(() => Date.now());

  // Auto-open when streaming starts
  React.useEffect(() => {
    if (isStreaming) {
      setOpen(true);
    }
  }, [isStreaming]);

  return (
    <ReasoningContext.Provider value={{ open, setOpen, isStreaming }}>
      <CollapsiblePrimitive.Root
        ref={ref}
        open={open}
        onOpenChange={setOpen}
        className={cn(
          "w-full rounded-lg border bg-card/50 shadow-sm overflow-hidden",
          isStreaming && "border-purple-500/30",
          className
        )}
        {...props}
      />
    </ReasoningContext.Provider>
  );
});
Reasoning.displayName = "Reasoning";

interface ReasoningTriggerProps extends React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleTrigger> {
  /** Custom label - defaults to "Reasoning" */
  label?: string;
  /** Show elapsed time indicator */
  showTime?: boolean;
}

/**
 * Clickable trigger that toggles reasoning content visibility.
 */
const ReasoningTrigger = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleTrigger>,
  ReasoningTriggerProps
>(({ className, children, label, showTime = false, ...props }, ref) => {
  const context = React.useContext(ReasoningContext);
  const [elapsed, setElapsed] = React.useState(0);

  // Track elapsed time during streaming
  React.useEffect(() => {
    if (!context?.isStreaming || !showTime) return;

    const interval = setInterval(() => {
      setElapsed(prev => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [context?.isStreaming, showTime]);

  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      ref={ref}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-sm font-medium transition-all",
        "text-muted-foreground hover:text-foreground hover:bg-muted/30",
        "[&[data-state=open]>svg.chevron]:rotate-180",
        context?.isStreaming && "text-purple-600",
        className
      )}
      {...props}
    >
      <Brain className={cn(
        "h-4 w-4",
        context?.isStreaming && "animate-pulse text-purple-500"
      )} />
      <span className="flex-1 text-left text-xs font-medium">
        {children || label || "Reasoning Process"}
      </span>
      {context?.isStreaming && (
        <span className="text-[10px] text-purple-500 bg-purple-500/10 px-1.5 py-0.5 rounded-full animate-pulse">
          Thinking...
        </span>
      )}
      {showTime && elapsed > 0 && (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock className="h-3 w-3" />
          {elapsed}s
        </span>
      )}
      <ChevronDown className="chevron h-4 w-4 text-muted-foreground transition-transform duration-200" />
    </CollapsiblePrimitive.CollapsibleTrigger>
  );
});
ReasoningTrigger.displayName = "ReasoningTrigger";

/**
 * Collapsible content area for reasoning text.
 * Renders content using MarkdownContent for proper formatting.
 */
const ReasoningContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(({ className, children, ...props }, ref) => {
  const context = React.useContext(ReasoningContext);
  
  // Convert children to string for markdown rendering
  const content = typeof children === 'string' ? children : 
    React.Children.toArray(children).map(child => 
      typeof child === 'string' ? child : ''
    ).join('');

  return (
    <CollapsiblePrimitive.CollapsibleContent
      ref={ref}
      className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
      {...props}
    >
      <div
        className={cn(
          "border-t px-4 py-3 text-sm text-muted-foreground leading-relaxed",
          "bg-gradient-to-b from-muted/30 to-transparent",
          context?.isStreaming && "animate-pulse",
          className
        )}
      >
        <MarkdownContent content={content} className="text-sm" />
      </div>
    </CollapsiblePrimitive.CollapsibleContent>
  );
});
ReasoningContent.displayName = "ReasoningContent";

export { Reasoning, ReasoningTrigger, ReasoningContent };

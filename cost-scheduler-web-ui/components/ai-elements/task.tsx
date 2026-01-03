"use client"

import * as React from "react"
import { Check, Circle, Loader2, ChevronDown, ChevronRight, FileIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

interface TaskContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const TaskContext = React.createContext<TaskContextValue | undefined>(undefined);

const Task = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>
>(({ className, defaultOpen = true, ...props }, ref) => {
  const [open, setOpen] = React.useState(defaultOpen);
  
  return (
    <TaskContext.Provider value={{ open, setOpen }}>
      <CollapsiblePrimitive.Root
        ref={ref}
        open={open}
        onOpenChange={setOpen}
        className={cn("w-full rounded-lg border bg-card shadow-sm", className)}
        {...props}
      />
    </TaskContext.Provider>
  );
});
Task.displayName = "Task";

interface TaskTriggerProps extends Omit<React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleTrigger>, 'title'> {
  title: string;
  status?: TaskStatus;
}

const TaskTrigger = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleTrigger>,
  TaskTriggerProps
>(({ className, title, status = 'pending', ...props }, ref) => {
  const context = React.useContext(TaskContext);
  
  const statusIcon = {
    pending: <Circle className="h-4 w-4 text-muted-foreground" />,
    in_progress: <Loader2 className="h-4 w-4 text-primary animate-spin" />,
    completed: <Check className="h-4 w-4 text-success" />,
    failed: <Circle className="h-4 w-4 text-destructive" />,
  };

  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      ref={ref}
      className={cn(
        "flex w-full items-center gap-3 px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/50",
        className
      )}
      {...props}
    >
      {statusIcon[status]}
      <span className="flex-1 text-left">{title}</span>
      {context?.open ? (
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      )}
    </CollapsiblePrimitive.CollapsibleTrigger>
  );
});
TaskTrigger.displayName = "TaskTrigger";

const TaskContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(({ className, ...props }, ref) => (
  <CollapsiblePrimitive.CollapsibleContent
    ref={ref}
    className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
    {...props}
  >
    <div className={cn("border-t px-4 py-3 space-y-2", className)}>
      {props.children}
    </div>
  </CollapsiblePrimitive.CollapsibleContent>
));
TaskContent.displayName = "TaskContent";

interface TaskItemProps extends React.HTMLAttributes<HTMLDivElement> {
  status?: TaskStatus;
  children: React.ReactNode;
}

const TaskItem = React.forwardRef<HTMLDivElement, TaskItemProps>(
  ({ className, status, children, ...props }, ref) => {
    const statusIcon = {
      pending: <Circle className="h-3 w-3 text-muted-foreground" />,
      in_progress: <Loader2 className="h-3 w-3 text-primary animate-spin" />,
      completed: <Check className="h-3 w-3 text-success" />,
      failed: <Circle className="h-3 w-3 text-destructive" />,
    };

    return (
      <div
        ref={ref}
        className={cn("flex items-start gap-2 text-sm text-muted-foreground", className)}
        {...props}
      >
        {status && statusIcon[status]}
        <span className="flex-1">{children}</span>
      </div>
    );
  }
);
TaskItem.displayName = "TaskItem";

interface TaskItemFileProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
}

const TaskItemFile = React.forwardRef<HTMLSpanElement, TaskItemFileProps>(
  ({ className, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-mono",
        className
      )}
      {...props}
    >
      <FileIcon className="h-3 w-3" />
      {children}
    </span>
  )
);
TaskItemFile.displayName = "TaskItemFile";

export { Task, TaskTrigger, TaskContent, TaskItem, TaskItemFile };

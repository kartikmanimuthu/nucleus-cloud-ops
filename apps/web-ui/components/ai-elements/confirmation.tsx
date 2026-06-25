"use client"

import * as React from "react"
import { Check, X, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

export type ConfirmationApproval = {
  id: string;
  state: 'pending' | 'approved' | 'rejected';
};

interface ConfirmationContextValue {
  approval?: ConfirmationApproval;
  state?: 'pending' | 'approved' | 'rejected' | 'call' | 'result';
}

const ConfirmationContext = React.createContext<ConfirmationContextValue>({});

interface ConfirmationProps extends React.HTMLAttributes<HTMLDivElement> {
  approval?: ConfirmationApproval;
  state?: 'pending' | 'approved' | 'rejected' | 'call' | 'result';
}

const Confirmation = React.forwardRef<HTMLDivElement, ConfirmationProps>(
  ({ className, approval, state, children, ...props }, ref) => {
    const contextState = approval?.state || state;
    
    return (
      <ConfirmationContext.Provider value={{ approval, state: contextState }}>
        <div
          ref={ref}
          className={cn(
            "rounded-lg border p-4",
            contextState === 'approved' && "border-green-500/20 bg-success/100/5",
            contextState === 'rejected' && "border-destructive/20 bg-destructive/5",
            contextState === 'pending' && "border-yellow-500/20 bg-warning/100/5",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </ConfirmationContext.Provider>
    );
  }
);
Confirmation.displayName = "Confirmation";

const ConfirmationRequest = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => {
  const { state } = React.useContext(ConfirmationContext);
  
  if (state !== 'pending' && state !== 'call') return null;
  
  return (
    <div
      ref={ref}
      className={cn("flex items-start gap-3", className)}
      {...props}
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-warning/100/10">
        <AlertTriangle className="h-4 w-4 text-warning" />
      </div>
      <div className="flex-1 space-y-1">
        <p className="text-sm font-medium text-yellow-700">Approval Required</p>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
});
ConfirmationRequest.displayName = "ConfirmationRequest";

const ConfirmationAccepted = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => {
  const { state } = React.useContext(ConfirmationContext);
  
  if (state !== 'approved') return null;
  
  return (
    <div
      ref={ref}
      className={cn("flex items-center gap-2 text-success", className)}
      {...props}
    >
      <Check className="h-4 w-4" />
      <span className="text-sm font-medium">{children}</span>
    </div>
  );
});
ConfirmationAccepted.displayName = "ConfirmationAccepted";

const ConfirmationRejected = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => {
  const { state } = React.useContext(ConfirmationContext);
  
  if (state !== 'rejected') return null;
  
  return (
    <div
      ref={ref}
      className={cn("flex items-center gap-2 text-destructive", className)}
      {...props}
    >
      <X className="h-4 w-4" />
      <span className="text-sm font-medium">{children}</span>
    </div>
  );
});
ConfirmationRejected.displayName = "ConfirmationRejected";

const ConfirmationActions = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  const { state } = React.useContext(ConfirmationContext);
  
  if (state !== 'pending' && state !== 'call') return null;
  
  return (
    <div
      ref={ref}
      className={cn("mt-3 flex items-center gap-2", className)}
      {...props}
    />
  );
});
ConfirmationActions.displayName = "ConfirmationActions";

interface ConfirmationActionProps extends React.ComponentPropsWithoutRef<typeof Button> {
  variant?: 'default' | 'outline' | 'destructive';
}

const ConfirmationAction = React.forwardRef<
  React.ElementRef<typeof Button>,
  ConfirmationActionProps
>(({ className, variant = 'default', ...props }, ref) => (
  <Button
    ref={ref}
    size="sm"
    variant={variant}
    className={cn("h-8", className)}
    {...props}
  />
));
ConfirmationAction.displayName = "ConfirmationAction";

export {
  Confirmation,
  ConfirmationRequest,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationActions,
  ConfirmationAction,
};

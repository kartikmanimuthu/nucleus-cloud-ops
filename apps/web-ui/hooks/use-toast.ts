"use client";

/**
 * Compatibility shim — single toast system is now sonner.
 *
 * Preserves the legacy Radix-style `useToast()` / `toast({ variant, title,
 * description })` API so existing call sites keep working unchanged, but
 * renders everything through sonner. New code should import `toast` from
 * "sonner" directly.
 */
import type { ReactNode } from "react";
import { toast as sonnerToast, type ExternalToast } from "sonner";

type ToastVariant = "default" | "destructive" | "success" | "warning" | "info";

export interface ToastInput {
  title?: ReactNode;
  description?: ReactNode;
  variant?: ToastVariant;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

function toast({ title, description, variant = "default", duration, action }: ToastInput) {
  // Use title as the headline; fall back to description when only it is given.
  const message: ReactNode = title ?? description ?? "";

  const opts: ExternalToast = {};
  if (title && description) opts.description = description;
  if (duration !== undefined) opts.duration = duration;
  if (action) opts.action = action;

  let id: string | number;
  switch (variant) {
    case "destructive":
      id = sonnerToast.error(message, opts);
      break;
    case "success":
      id = sonnerToast.success(message, opts);
      break;
    case "warning":
      id = sonnerToast.warning(message, opts);
      break;
    case "info":
      id = sonnerToast.info(message, opts);
      break;
    default:
      id = sonnerToast(message, opts);
  }

  return {
    id,
    dismiss: () => sonnerToast.dismiss(id),
    update: () => {
      /* no-op: sonner updates via toast(id) — not needed by current call sites */
    },
  };
}

function useToast() {
  return {
    toast,
    dismiss: (toastId?: string | number) => sonnerToast.dismiss(toastId),
  };
}

export { useToast, toast };

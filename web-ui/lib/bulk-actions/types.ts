// Shared, module-agnostic contract for bulk actions across list/table views
// (AWS Accounts, Cost Scheduler, and future modules).
//
// To add a new bulk action: add one `BulkAction` entry to the module's action
// config array and one matching `case` in that module's bulk API route.
import type { LucideIcon } from "lucide-react";

/**
 * A single bulk action presented in the floating BulkActionBar.
 * `key` is the identifier sent to the module's bulk endpoint.
 */
export interface BulkAction {
    key: string;
    label: string;
    icon: LucideIcon;
    /** Button styling. Defaults to "outline". */
    variant?: "default" | "outline" | "destructive";
    /** When true, the bar shows a confirmation dialog before firing. */
    destructive?: boolean;
    confirmTitle?: string;
    confirmDescription?: string;
}

/** Per-item outcome returned by a bulk endpoint. */
export interface BulkItemResult {
    id: string;
    status: "success" | "error";
    error?: string;
}

/** Aggregate result of a bulk operation, with partial-success detail. */
export interface BulkActionResult {
    total: number;
    succeeded: number;
    failed: number;
    results: BulkItemResult[];
}

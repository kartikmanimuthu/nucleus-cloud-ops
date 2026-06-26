"use client";

import { cn } from "@/lib/utils";
import type { Finding, RiskLevel, RecommendationStatus } from "@/lib/db/repositories/right-sizing/interface";

export function formatMoney(n: number | null | undefined): string {
    if (n == null) return "—";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

export const FINDING_LABEL: Record<Finding, string> = {
    over_provisioned: "Over-provisioned",
    under_provisioned: "Under-provisioned",
    idle: "Idle",
    optimized: "Optimized",
};

const FINDING_CLASS: Record<Finding, string> = {
    over_provisioned: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    under_provisioned: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    idle: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
    optimized: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
};

const RISK_CLASS: Record<RiskLevel, string> = {
    low: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    high: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

const STATUS_CLASS: Record<RecommendationStatus, string> = {
    open: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    dismissed: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    snoozed: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    applied: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
};

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
    return (
        <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", className)}>
            {children}
        </span>
    );
}

export function FindingBadge({ finding }: { finding: Finding }) {
    return <Pill className={FINDING_CLASS[finding] ?? STATUS_CLASS.open}>{FINDING_LABEL[finding] ?? finding}</Pill>;
}

export function RiskBadge({ risk }: { risk: RiskLevel }) {
    return <Pill className={RISK_CLASS[risk] ?? RISK_CLASS.medium}>{risk}</Pill>;
}

export function StatusBadge({ status }: { status: RecommendationStatus }) {
    return <Pill className={STATUS_CLASS[status] ?? STATUS_CLASS.open}>{status}</Pill>;
}

export const RESOURCE_TYPE_LABELS: Record<string, string> = {
    ec2_instances: "EC2",
    rds_db_instances: "RDS",
    ec2_volumes: "EBS",
    autoscaling_auto_scaling_groups: "ASG",
};

'use client';

/**
 * New zone-based dashboard shell.
 *
 * Replaces dashboard-client.tsx. It owns the global time-range selector and
 * renders the six dashboard zones in a responsive grid.
 */
import { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { TimeRange } from '@/lib/dashboard-types';
import { HeroKpisSection } from './hero-kpis-section';
import { ActionCenterSection } from './action-center-section';
import { CoverageSection } from './coverage-section';
import { CostAutomationSection } from './cost-automation-section';
import { AgentActivitySection } from './agent-activity-section';
import { InventorySnapshotSection } from './inventory-snapshot-section';
import { AuditSnapshotSection } from './audit-snapshot-section';

const RANGE_OPTIONS: { label: string; value: TimeRange }[] = [
    { label: 'Last 24 hours', value: '24h' },
    { label: 'Last 7 days', value: '7d' },
    { label: 'Last 30 days', value: '30d' },
    { label: 'Last 90 days', value: '90d' },
];

export function DashboardShell() {
    const [range, setRange] = useState<TimeRange>('24h');

    return (
        <div className="space-y-6 p-4 md:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">Mission Control</h1>
                    <p className="text-muted-foreground text-sm">
                        Real-time health of your cloud operations.
                    </p>
                </div>
                <Select value={range} onValueChange={(v) => setRange(v as TimeRange)}>
                    <SelectTrigger className="w-[180px]">
                        <SelectValue placeholder="Select range" />
                    </SelectTrigger>
                    <SelectContent>
                        {RANGE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            <HeroKpisSection range={range} />

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <ActionCenterSection range={range} />
                <CoverageSection />
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <CostAutomationSection range={range} />
                <AgentActivitySection range={range} />
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <InventorySnapshotSection />
                <AuditSnapshotSection range={range} />
            </div>
        </div>
    );
}

'use client';

import type { ReactNode } from 'react';

export interface SetupStep {
    title: ReactNode;
    detail?: ReactNode;
}

/**
 * Numbered setup-guide step list shared by the channel settings pages.
 * `startAt` lets a guide split into sections while keeping one running
 * step sequence (e.g. Part 1 steps 1–5, Part 2 steps 6–9).
 */
export function SetupSteps({ steps, startAt = 1 }: { steps: SetupStep[]; startAt?: number }) {
    return (
        <ol className="space-y-4">
            {steps.map((step, i) => (
                <li key={i} className="flex gap-3">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {startAt + i}
                    </span>
                    <div className="min-w-0 space-y-1">
                        <div className="text-sm font-medium text-foreground">{step.title}</div>
                        {step.detail && <div className="text-sm text-muted-foreground">{step.detail}</div>}
                    </div>
                </li>
            ))}
        </ol>
    );
}

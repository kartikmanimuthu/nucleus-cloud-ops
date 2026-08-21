/**
 * A step reads differently in flight than once finished, so both forms are stored
 * up front: rendering picks by state. One shared label would print the
 * self-contradicting "✅ Running an AWS CLI command...".
 */
export interface StepPhrase {
    active: string;
    done: string;
}

export interface ChecklistStep {
    phrase: StepPhrase;
    /** Correlation key — the tool name for tool steps; absent for milestones. */
    key?: string;
    done: boolean;
}

export interface ChecklistState {
    steps: ChecklistStep[];
}

/** Keep the message well under Telegram's 4096-char cap. */
const EXPANDED_WINDOW = 6;

export function createChecklist(): ChecklistState {
    return { steps: [] };
}

export function addStep(
    state: ChecklistState,
    phrase: StepPhrase,
    opts: { key?: string; done?: boolean } = {},
): ChecklistState {
    return { steps: [...state.steps, { phrase, key: opts.key, done: opts.done ?? false }] };
}

/**
 * Complete the OLDEST pending step matching `key` (FIFO — tool results come back
 * in roughly call order, and matching oldest-first keeps repeated calls to the
 * same tool from collapsing onto one step). With no key, completes the oldest
 * pending step of any kind. A no-op when nothing matches.
 */
export function completeStep(state: ChecklistState, key?: string): ChecklistState {
    const index = state.steps.findIndex(
        (s) => !s.done && (key === undefined || s.key === key),
    );
    if (index === -1) return state;

    const steps = [...state.steps];
    steps[index] = { ...steps[index], done: true };
    return { steps };
}

export function renderChecklist(state: ChecklistState): string {
    const total = state.steps.length;
    if (total === 0) return 'Getting started...';

    const collapseCount = Math.max(0, total - EXPANDED_WINDOW);
    const collapsedDone = state.steps.slice(0, collapseCount).filter((s) => s.done).length;
    const visible = state.steps.slice(collapseCount);

    const lines: string[] = [];
    if (collapseCount > 0) {
        lines.push(`✅ ${collapsedDone} earlier step${collapsedDone === 1 ? '' : 's'} completed`);
    }
    for (const step of visible) {
        lines.push(step.done ? `✅ ${step.phrase.done}` : `⏳ ${step.phrase.active}`);
    }
    return lines.join('\n');
}

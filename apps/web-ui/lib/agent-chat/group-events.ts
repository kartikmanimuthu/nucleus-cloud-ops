// Pure grouping pass over TranscriptEvent[]: collapses runs of >=3
// consecutive, all-`done` tool events into a single `tool-group` row so a
// long streak of successful tool calls doesn't dominate the transcript. No
// React here — consumed by workspace event-row components (Task 6+).

import type { TranscriptEvent } from './events';

type ToolEvent = Extract<TranscriptEvent, { kind: 'tool' }>;

export interface ToolGroup {
    kind: 'tool-group';
    id: string;
    tools: ToolEvent[];
}

const MIN_GROUP_SIZE = 3;

function isTool(event: TranscriptEvent): event is ToolEvent {
    return event.kind === 'tool';
}

/**
 * Groups consecutive runs of >=3 `tool` events, all with status `done`, into
 * a single `tool-group` entry. A run containing any `running`/`error`/
 * `rejected` tool is left ungrouped (passed through individually). Non-tool
 * events always pass through unchanged, in order.
 */
export function groupEvents(
    events: TranscriptEvent[]
): Array<TranscriptEvent | ToolGroup> {
    const result: Array<TranscriptEvent | ToolGroup> = [];
    let i = 0;

    while (i < events.length) {
        const event = events[i];

        if (!isTool(event)) {
            result.push(event);
            i += 1;
            continue;
        }

        // Collect the full consecutive run of tool events starting here.
        let j = i;
        const run: ToolEvent[] = [];
        while (j < events.length) {
            const candidate = events[j];
            if (!isTool(candidate)) break;
            run.push(candidate);
            j += 1;
        }

        const allDone = run.every((t) => t.status === 'done');
        if (run.length >= MIN_GROUP_SIZE && allDone) {
            result.push({ kind: 'tool-group', id: `group:${run[0].id}`, tools: run });
        } else {
            result.push(...run);
        }

        i = j;
    }

    return result;
}

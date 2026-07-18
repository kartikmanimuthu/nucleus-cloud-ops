// The ONLY code (besides route.ts's persistence-format getPhaseMarker) allowed
// to know the legacy sentinel strings after Task 4. Ports the marker mapping
// from components/agent/chat-interface.tsx's parsePhaseFromContent (L147-188).
//
// Historically, processStream (app/api/chat/route.ts) prefixed the first
// reasoning/text delta of a phase with one of these markers before streaming
// it live, AND prefixes stored AI message content the same way before
// persistence (see route.ts's `finally` block). Live streaming of the marker
// was removed in Task 4 — typed `data-phase` parts carry the phase instead —
// but persisted history still carries the marker prefix, so replaying history
// still needs this mapping.
import type { AgentPhaseName } from './events';

const MARKER_TO_PHASE: Array<[string, AgentPhaseName]> = [
    ['PLANNING_PHASE_START\n', 'planning'],
    ['EXECUTION_PHASE_START\n', 'execution'],
    ['REFLECTION_PHASE_START\n', 'reflection'],
    ['REVISION_PHASE_START\n', 'revision'],
    ['FINAL_PHASE_START\n', 'final'],
    ['MEMORY_RECALL_PHASE_START\n', 'memory_recall'],
    ['MEMORY_SAVE_PHASE_START\n', 'memory_save'],
];

export function normalizeLegacyContent(content: string): { phase: AgentPhaseName; text: string } {
    for (const [marker, phase] of MARKER_TO_PHASE) {
        if (content.startsWith(marker)) {
            return { phase, text: content.slice(marker.length) };
        }
    }
    return { phase: 'text', text: content };
}

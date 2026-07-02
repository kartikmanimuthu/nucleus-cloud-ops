export type MemoryKind = 'SEMANTIC' | 'EPISODIC' | 'PROCEDURAL';

export interface SemanticValue { fact: string; source: string; confidence: 'high' | 'medium'; }
export interface EpisodicValue { context: string; reasoning: string; action: string; outcome: string; }
export interface ProceduralValue { instruction: string; trigger: string; evidence: string; confidence?: 'high' | 'medium'; }

export interface MemoryHit {
    id: string;
    namespace: string;
    key: string;
    value: Record<string, unknown>;
    kind: MemoryKind;
    /** Cosine distance to the query (0 = identical); present only on vector-search hits. */
    distance?: number;
}

export interface Scratchpad {
    openGoals: string[];
    keyFindings: string[];
    resourceIds: string[];
    pendingSteps: string[];
}

export interface WorkingMemory {
    runningSummary: string;
    scratchpad: Scratchpad;
    tokenCount: number;
    turnCount: number;
}

export interface ExtractedFact {
    /** Memory layer this item belongs to; absent = 'SEMANTIC'. */
    kind?: MemoryKind;
    namespace: string[];
    key: string;
    value: SemanticValue | ProceduralValue;
}

export type ReconcileAction = 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'REINFORCE' | 'NOOP';

export interface ReconcileDecision {
    factIndex: number;
    action: ReconcileAction;
    targetId?: string;                     // UPDATE / SUPERSEDE / REINFORCE
    mergedValue?: Record<string, unknown>; // UPDATE only
}

export interface ReconcileSummary {
    added: number;
    updated: number;
    superseded: number;
    reinforced: number;
    noop: number;
    failed: number;
}

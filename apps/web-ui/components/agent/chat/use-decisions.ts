"use client";

import { useEffect, useMemo, useRef, useState } from 'react';

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export interface Decision { approved: boolean; reason?: string; answer?: string }
export interface DecisionMap { [toolCallId: string]: Decision }

export function useDecisions(opts: {
    pendingToolCallIds: string[];
    onComplete: (decisions: Array<{ toolCallId: string } & Decision>) => void;
}) {
    const { pendingToolCallIds, onComplete } = opts;
    const [decisions, setDecisions] = useState<DecisionMap>({});
    const firedRef = useRef(false);
    const onCompleteRef = useRef(onComplete);
    onCompleteRef.current = onComplete;

    const batchKey = pendingToolCallIds.join('|');
    // New batch → clear local decisions and re-arm completion.
    useEffect(() => {
        setDecisions({});
        firedRef.current = false;
    }, [batchKey]);

    useEffect(() => {
        if (firedRef.current || pendingToolCallIds.length === 0) return;
        const staleEntries = Object.keys(decisions).some(id => !pendingToolCallIds.includes(id));
        if (staleEntries) return; // decisions belong to a previous batch — reset effect will clear them
        const allDecided = pendingToolCallIds.every(id => decisions[id] !== undefined);
        if (!allDecided) return;
        firedRef.current = true;
        onCompleteRef.current(pendingToolCallIds.map(id => ({ toolCallId: id, ...decisions[id] })));
    }, [decisions, pendingToolCallIds]);

    const decide = (toolCallId: string, d: Decision) =>
        setDecisions(prev => ({ ...prev, [toolCallId]: d }));

    const decideRemaining = (approved: boolean) =>
        setDecisions(prev => {
            const next = { ...prev };
            for (const id of pendingToolCallIds) if (next[id] === undefined) next[id] = { approved };
            return next;
        });

    const decidedCount = pendingToolCallIds.filter(id => decisions[id] !== undefined).length;

    const allDecided =
        pendingToolCallIds.length > 0 &&
        pendingToolCallIds.every(id => decisions[id] !== undefined);

    // New Set instance whenever the decided batch completes — B1's useRunState
    // depends on this identity change to drop the batch from "pending" immediately.
    const resolvedIds = useMemo(
        () => (allDecided ? new Set(Object.keys(decisions)) : (EMPTY_SET as Set<string>)),
        [allDecided, decisions],
    );

    return { decisions, decide, decideRemaining, decidedCount, resolvedIds };
}

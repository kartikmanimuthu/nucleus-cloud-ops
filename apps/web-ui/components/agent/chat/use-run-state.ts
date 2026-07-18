'use client';

import { useMemo } from 'react';
import { deriveRunState, RunState } from './run-state';

export function useRunState(messages: unknown[], resolvedToolCallIds: Set<string>): RunState {
    return useMemo(
        () => deriveRunState(messages as any, resolvedToolCallIds),
        [messages, resolvedToolCallIds],
    );
}

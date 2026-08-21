import { describe, it, expect } from 'vitest';
import { todosToPlanSteps } from '@/lib/agent/deep/stream-adapt';

describe('todosToPlanSteps', () => {
    it('renames content to step and preserves status and order', () => {
        expect(todosToPlanSteps([
            { content: 'Check ECS service', status: 'completed' },
            { content: 'Scale up', status: 'in_progress' },
            { content: 'Verify', status: 'pending' },
        ])).toEqual([
            { step: 'Check ECS service', status: 'completed' },
            { step: 'Scale up', status: 'in_progress' },
            { step: 'Verify', status: 'pending' },
        ]);
    });

    it('returns an empty array for no todos', () => {
        expect(todosToPlanSteps([])).toEqual([]);
    });
});

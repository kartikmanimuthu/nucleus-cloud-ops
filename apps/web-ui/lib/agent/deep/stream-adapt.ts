import type { PlanStep } from '@/lib/agent/agent-shared';

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' };

export function todosToPlanSteps(todos: Todo[]): PlanStep[] {
    return todos.map(t => ({ step: t.content, status: t.status }));
}

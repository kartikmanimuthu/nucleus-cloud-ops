/**
 * Unit tests for the Agent Ops run → Markdown report builder.
 *
 * buildRunReportMarkdown() is the pure core of the "Download Markdown" export.
 * It reuses the SAME buildSteps() model as the UI timeline and the PDF export,
 * so the three renderings never drift.
 */

import { describe, it, expect } from 'vitest';
import { buildRunReportMarkdown } from '../../lib/agent-ops/export-markdown';
import type { AgentOpsRun, AgentOpsEvent } from '../../lib/agent-ops/types';

let seq = 0;
function makeEvent(overrides: Partial<AgentOpsEvent>): AgentOpsEvent {
    seq += 1;
    return {
        id: `ev-${seq}`,
        tenantId: 't1',
        runId: 'run-1',
        eventType: 'execution',
        node: 'generate',
        content: '',
        createdAt: new Date(1700000000000 + seq * 1000).toISOString(),
        ...overrides,
    } as AgentOpsEvent;
}

function makeRun(overrides: Partial<AgentOpsRun> = {}): AgentOpsRun {
    return {
        id: 'row-1',
        tenantId: 't1',
        runId: '5fbe4722-dd12-4fae-8c17-f4b2922bcb8a',
        source: 'api',
        status: 'completed',
        taskDescription: 'Check the cost anomaly and report in slack',
        mode: 'plan',
        autoApprove: false,
        threadId: 'th-1',
        createdAt: new Date(1700000000000).toISOString(),
        ...overrides,
    } as AgentOpsRun;
}

describe('buildRunReportMarkdown', () => {
    it('renders header, status, and metadata', () => {
        const md = buildRunReportMarkdown(makeRun(), []);
        expect(md).toContain('# Agent Ops Run Report');
        expect(md).toContain('5fbe4722-dd12-4fae-8c17-f4b2922bcb8a');
        expect(md).toContain('COMPLETED');
        expect(md).toContain('| Source |');
        expect(md).toContain('| api |');
    });

    it('renders the task description with skill and account', () => {
        const md = buildRunReportMarkdown(
            makeRun({ selectedSkill: 'cost-analyser', accountName: 'STX-MTSL', accountId: '590183986748' }),
            [],
        );
        expect(md).toContain('## Task Description');
        expect(md).toContain('Check the cost anomaly and report in slack');
        expect(md).toContain('cost-analyser');
        expect(md).toContain('STX-MTSL');
    });

    it('renders result summary and tools used', () => {
        const md = buildRunReportMarkdown(
            makeRun({ result: { summary: 'July trending 39% above June', toolsUsed: ['execute_command', 'get_aws_credentials'], iterations: 4 } as any }),
            [],
        );
        expect(md).toContain('## Result');
        expect(md).toContain('July trending 39% above June');
        expect(md).toContain('execute_command');
    });

    it('renders the error section for failed runs', () => {
        const md = buildRunReportMarkdown(makeRun({ status: 'failed', error: 'ValidationException: boom' }), []);
        expect(md).toContain('## Error');
        expect(md).toContain('ValidationException: boom');
        expect(md).toContain('FAILED');
    });

    it('renders a paired tool step with fenced arguments and output', () => {
        const events = [
            makeEvent({ eventType: 'tool_call', node: 'tools', toolName: 'get_aws_credentials', toolArgs: { accountId: '590183986748' } }),
            makeEvent({ eventType: 'tool_result', node: 'tools', toolName: 'get_aws_credentials', toolOutput: '{"success":true}' }),
        ];
        const md = buildRunReportMarkdown(makeRun(), events);
        expect(md).toContain('get_aws_credentials');
        expect(md).toContain('**Arguments:**');
        expect(md).toContain('"accountId": "590183986748"');
        expect(md).toContain('**Output:**');
        expect(md).toContain('{"success":true}');
        expect(md).toContain('```json');
    });

    it('escapes tool output containing triple backticks with a longer fence', () => {
        const events = [
            makeEvent({ eventType: 'tool_call', node: 'tools', toolName: 'read_file', toolArgs: { path: 'x.md' } }),
            makeEvent({ eventType: 'tool_result', node: 'tools', toolName: 'read_file', toolOutput: 'text\n```js\ncode\n```\nmore' }),
        ];
        const md = buildRunReportMarkdown(makeRun(), events);
        // The inner ``` must not terminate the fence — a 4-backtick fence wraps it.
        expect(md).toContain('````');
        expect(md).toContain('```js');
    });

    it('renders "Worked" groups EXPANDED with every tool call visible', () => {
        // 3+ contiguous tool steps fold into a group in the UI; markdown renders
        // the group header AND all nested steps (a document can't be clicked open).
        const events = ['a', 'b', 'c'].flatMap(name => [
            makeEvent({ eventType: 'tool_call', node: 'tools', toolName: `tool_${name}`, toolArgs: { name } }),
            makeEvent({ eventType: 'tool_result', node: 'tools', toolName: `tool_${name}`, toolOutput: `out-${name}` }),
        ]);
        const md = buildRunReportMarkdown(makeRun(), events);
        expect(md).toContain('Worked — 3 tool calls');
        expect(md).toContain('tool_a');
        expect(md).toContain('tool_b');
        expect(md).toContain('tool_c');
        expect(md).toContain('out-c');
    });

    it('renders planning, reflection, memory, and evaluation steps', () => {
        const events = [
            makeEvent({ eventType: 'memory_recall', node: 'memory_recall', content: 'Recalled 5 facts · 1 rule', metadata: { facts: [1, 2, 3, 4, 5], rules: [1], episodes: [] } as any }),
            makeEvent({ eventType: 'evaluation', node: 'evaluator', content: 'Cost task, read-only', metadata: { mode: 'plan', skillName: 'cost-analyser' } as any }),
            makeEvent({ eventType: 'planning', node: 'planner', content: 'Plan created:\n1. Get credentials\n2. Query costs' }),
            makeEvent({ eventType: 'reflection', node: 'reflect', content: 'All steps complete.' }),
        ];
        const md = buildRunReportMarkdown(makeRun(), events);
        expect(md).toContain('Recalled 5 facts');
        expect(md).toContain('Evaluated request');
        expect(md).toContain('1. Get credentials');
        expect(md).toContain('All steps complete.');
    });

    it('marks a cancelled run in the timeline', () => {
        const events = [makeEvent({ eventType: 'final', node: '__cancelled__', content: 'Run was cancelled by user.' })];
        const md = buildRunReportMarkdown(makeRun({ status: 'cancelled' }), events);
        expect(md).toContain('Run cancelled');
        expect(md).toContain('CANCELLED');
    });

    it('handles a run with no events', () => {
        const md = buildRunReportMarkdown(makeRun(), []);
        expect(md).toContain('No events recorded.');
    });
});

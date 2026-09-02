import { describe, it, expect, vi } from 'vitest';
import type { AgentOpsRun, AgentOpsEvent } from './types';

const BASE_RUN: AgentOpsRun = {
    PK: 'TENANT#t1', SK: 'RUN#r1', GSI1PK: 'SOURCE#api', GSI1SK: 'x',
    runId: 'run-12345678', tenantId: 't1', source: 'api', status: 'completed',
    taskDescription: 'Stop the <script> instance', mode: 'plan', threadId: 'thread-1',
    trigger: {} as any, createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z',
    ttl: 0,
};

function makeEvent(overrides: Partial<AgentOpsEvent> = {}): AgentOpsEvent {
    return {
        PK: 'RUN#run-1', SK: 'EVENT#1', runId: 'run-1', eventType: 'execution', node: 'generate',
        createdAt: '2026-02-01T00:01:00Z', ttl: 0,
        ...overrides,
    };
}

describe('buildRunReportHtml', () => {
    it('includes the run id, status, and escaped task description', async () => {
        const { buildRunReportHtml } = await import('./export-pdf');
        const html = buildRunReportHtml(BASE_RUN, []);

        expect(html).toContain('run-12345678');
        expect(html).toContain('COMPLETED');
        expect(html).toContain('Stop the &lt;script&gt; instance');
        expect(html).not.toContain('<script>');
    });

    it('escapes HTML-significant characters in event content (XSS safety)', async () => {
        const { buildRunReportHtml } = await import('./export-pdf');
        const html = buildRunReportHtml(BASE_RUN, [
            makeEvent({ content: '<img src=x onerror=alert(1)> & "quoted"' }),
        ]);

        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;');
    });

    it('renders the result section only when a result summary is present', async () => {
        const { buildRunReportHtml } = await import('./export-pdf');
        const withResult = buildRunReportHtml({ ...BASE_RUN, result: { summary: 'All done', toolsUsed: ['stop_ec2'], iterations: 3 } as any }, []);
        expect(withResult).toContain('All done');
        expect(withResult).toContain('stop_ec2');
        expect(withResult).toContain('3 iteration(s)');

        const withoutResult = buildRunReportHtml(BASE_RUN, []);
        expect(withoutResult).not.toContain('✅ Result');
    });

    it('renders the error section only when the run has an error', async () => {
        const { buildRunReportHtml } = await import('./export-pdf');
        const withError = buildRunReportHtml({ ...BASE_RUN, error: 'Bedrock timeout' }, []);
        expect(withError).toContain('❌ Error');
        expect(withError).toContain('Bedrock timeout');

        const withoutError = buildRunReportHtml(BASE_RUN, []);
        expect(withoutError).not.toContain('❌ Error');
    });

    it('renders a placeholder when there are no events', async () => {
        const { buildRunReportHtml } = await import('./export-pdf');
        const html = buildRunReportHtml(BASE_RUN, []);
        expect(html).toContain('No events recorded.');
    });

    it('renders tool name, token count, and args for a tool-call event', async () => {
        const { buildRunReportHtml } = await import('./export-pdf');
        const html = buildRunReportHtml(BASE_RUN, [
            makeEvent({
                eventType: 'tool_call', toolName: 'stop_ec2', toolArgs: { instanceId: 'i-123' },
                metadata: { inputTokens: 10, outputTokens: 5 },
            }),
        ]);

        expect(html).toContain('stop_ec2');
        expect(html).toContain('15 tk');
        expect(html).toContain('instanceId');
        expect(html).toContain('i-123');
    });

    it('applies distinct styling for a "thinking" content event', async () => {
        const { buildRunReportHtml } = await import('./export-pdf');
        const html = buildRunReportHtml(BASE_RUN, [
            makeEvent({ content: 'Considering options', metadata: { contentType: 'thinking' } }),
        ]);
        expect(html).toContain('Thinking');
        expect(html).toContain('Considering options');
    });

    it('renders a tool_result event with the tool-result content style', async () => {
        const { buildRunReportHtml } = await import('./export-pdf');
        const html = buildRunReportHtml(BASE_RUN, [
            makeEvent({ eventType: 'tool_result', toolOutput: 'Instance stopped' }),
        ]);
        expect(html).toContain('Instance stopped');
    });

    it('renders an error event with the error content style', async () => {
        const { buildRunReportHtml } = await import('./export-pdf');
        const html = buildRunReportHtml(BASE_RUN, [makeEvent({ eventType: 'error', content: 'Tool failed' })]);
        expect(html).toContain('Tool failed');
    });

    it('shows selected skill and account name when present', async () => {
        const { buildRunReportHtml } = await import('./export-pdf');
        const html = buildRunReportHtml({ ...BASE_RUN, selectedSkill: 'ec2-ops', accountName: 'Prod', accountId: 'acc-1' }, []);
        expect(html).toContain('Skill: ec2-ops');
        expect(html).toContain('Account: Prod (acc-1)');
    });

    it('falls back to a default status style for an unrecognized status', async () => {
        const { buildRunReportHtml } = await import('./export-pdf');
        const html = buildRunReportHtml({ ...BASE_RUN, status: 'awaiting_input' as any }, []);
        expect(html).toContain('AWAITING INPUT');
    });
});

describe('exportRunToPdf', () => {
    function makeDocApi() {
        let pageCount = 1;
        return {
            setFont: vi.fn(), setFontSize: vi.fn(), setTextColor: vi.fn(), setDrawColor: vi.fn(), setLineWidth: vi.fn(),
            setFillColor: vi.fn(), splitTextToSize: vi.fn((s: string) => [s]), getTextWidth: vi.fn(() => 10),
            text: vi.fn(), line: vi.fn(), roundedRect: vi.fn(),
            // The shared writer sizes the page off the document itself.
            internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
            addPage: vi.fn(() => { pageCount += 1; }),
            getNumberOfPages: vi.fn(() => pageCount), setPage: vi.fn(), save: vi.fn(),
        };
    }

    it('renders the run through jsPDF and triggers a save with a derived filename', async () => {
        const docApi = makeDocApi();
        vi.doMock('jspdf', () => ({ jsPDF: vi.fn().mockImplementation(function () { return docApi; }) }));

        const { exportRunToPdf } = await import('./export-pdf');
        await exportRunToPdf(BASE_RUN, [makeEvent({ eventType: 'tool_call', toolName: 'stop_ec2', toolArgs: { a: 1 } })]);

        expect(docApi.save).toHaveBeenCalledWith(expect.stringContaining('agent-ops-run-run-1234'));
        vi.doUnmock('jspdf');
    });

    it('renders every step kind (memory, evaluation, planning, thinking, grouped tools, reflection, revision, final, error), a completedAt meta pair, and paginates across multiple pages', async () => {
        const docApi = makeDocApi();
        vi.doMock('jspdf', () => ({ jsPDF: vi.fn().mockImplementation(function () { return docApi; }) }));

        const t = (i: number) => `2026-02-01T00:${String(i).padStart(2, '0')}:00Z`;
        const events: AgentOpsEvent[] = [
            makeEvent({ eventType: 'memory_recall', createdAt: t(1), metadata: { facts: [1, 2], rules: [1], episodes: [] } }),
            makeEvent({ eventType: 'memory_save', createdAt: t(2), metadata: { savedFacts: 2, savedRules: 1, episodeCaptured: true } }),
            makeEvent({
                eventType: 'evaluation', createdAt: t(3), content: 'Evaluating request',
                metadata: { mode: 'plan', skillName: 'ec2-ops', knowledgeBaseIds: ['kb1'], requiresApproval: true },
            }),
            makeEvent({ eventType: 'planning', node: 'planner', createdAt: t(4), content: 'Planning next step' }),
            makeEvent({ eventType: 'execution', createdAt: t(5), content: '' }), // thinking with no content -> break, no render
            // 3 contiguous tool_call/tool_result pairs -> folded into one "group" step
            makeEvent({ eventType: 'tool_call', createdAt: t(6), toolName: 'describe_instances', toolArgs: { region: 'us-east-1' } }),
            makeEvent({ eventType: 'tool_result', createdAt: t(7), toolName: 'describe_instances', toolOutput: 'Found 2 instances' }),
            makeEvent({ eventType: 'tool_call', createdAt: t(8), toolName: 'noop_tool' }),
            makeEvent({ eventType: 'tool_result', createdAt: t(9), toolName: 'noop_tool' }), // no args, no output -> "No detail captured."
            makeEvent({ eventType: 'tool_call', createdAt: t(10), toolName: 'stop_ec2', toolArgs: { instanceId: 'i-9' } }),
            makeEvent({ eventType: 'tool_result', createdAt: t(11), toolName: 'stop_ec2', toolOutput: 'Error: instance not found' }),
            makeEvent({ eventType: 'reflection', createdAt: t(12), content: 'Reflecting on the outcome' }),
            makeEvent({ eventType: 'revision', createdAt: t(13), content: 'Revising the plan' }),
            makeEvent({
                eventType: 'error', createdAt: t(14),
                content: 'A very long failure line that exceeds one hundred and ten characters so that the firstLine helper truncates it with an ellipsis at the end',
            }),
            makeEvent({ eventType: 'final', createdAt: t(15), content: 'All done!' }),
            // Pad with enough additional planning steps to force real pagination.
            ...Array.from({ length: 30 }, (_, i) => makeEvent({
                eventType: 'planning', node: 'planner', createdAt: t(16 + i),
                content: `Padding planning step number ${i} to accumulate enough vertical space to trigger a page break`,
            })),
        ];

        const { exportRunToPdf } = await import('./export-pdf');
        await exportRunToPdf(
            { ...BASE_RUN, completedAt: '2026-02-01T00:30:00Z', result: { summary: 'Stopped 1 instance', toolsUsed: ['stop_ec2'], iterations: 2 } as any },
            events,
        );

        expect(docApi.save).toHaveBeenCalled();
        expect(docApi.addPage).toHaveBeenCalled();
        expect(docApi.getNumberOfPages()).toBeGreaterThan(1);
        vi.doUnmock('jspdf');
    });

    it('reports an unrecognized run status in the meta block and renders the no-events placeholder', async () => {
        const docApi = makeDocApi();
        vi.doMock('jspdf', () => ({ jsPDF: vi.fn().mockImplementation(function () { return docApi; }) }));

        const { exportRunToPdf } = await import('./export-pdf');
        await exportRunToPdf({ ...BASE_RUN, status: 'awaiting_input' as any }, []);

        expect(docApi.text).toHaveBeenCalledWith('Status: awaiting input', expect.anything(), expect.anything());
        expect(docApi.text).toHaveBeenCalledWith('No events recorded.', expect.anything(), expect.anything());
        vi.doUnmock('jspdf');
    });

    it('marks an unmatched, still-open tool call as running for an active run status', async () => {
        const docApi = makeDocApi();
        vi.doMock('jspdf', () => ({ jsPDF: vi.fn().mockImplementation(function () { return docApi; }) }));

        const { exportRunToPdf } = await import('./export-pdf');
        await exportRunToPdf(
            { ...BASE_RUN, status: 'in_progress' },
            [makeEvent({ eventType: 'tool_call', toolName: 'start_ec2', toolArgs: { instanceId: 'i-1' } })],
        );

        expect(docApi.text).toHaveBeenCalledWith(expect.stringContaining('running'), expect.anything(), expect.anything());
        vi.doUnmock('jspdf');
    });
});

describe('exportRunToPdf — markdown result rendering', () => {
    function makeDocApi() {
        let pageCount = 1;
        return {
            setFont: vi.fn(), setFontSize: vi.fn(), setTextColor: vi.fn(), setDrawColor: vi.fn(), setLineWidth: vi.fn(),
            setFillColor: vi.fn(), splitTextToSize: vi.fn((s: string) => [s]), getTextWidth: vi.fn(() => 10),
            text: vi.fn(), line: vi.fn(), roundedRect: vi.fn(), rect: vi.fn(),
            internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
            addPage: vi.fn(() => { pageCount += 1; }),
            getNumberOfPages: vi.fn(() => pageCount), setPage: vi.fn(), save: vi.fn(),
        };
    }

    /** Everything the exporter actually drew, as one searchable string. */
    const drawn = (docApi: ReturnType<typeof makeDocApi>) =>
        docApi.text.mock.calls.map((c) => String(c[0])).join('\n');

    const SUMMARY = [
        'Here is the full health report for **STX-CLOUD-PLATFORM** \u2014 us-east-1:',
        '',
        '---',
        '',
        '## \u{1F534} Issues Found',
        '',
        '### EC2 \u2014 2 Stopped Instances',
        '',
        '| Instance ID | Name | Type | State |',
        '|---|---|---|---|',
        '| `i-01f7c1204bc06cd79` | **llm-inference-g6e** | g6.xlarge | \u{1F534} **STOPPED** |',
        '| `i-034e3f4b41aec03ff` | **llm-inference-coding** | g6e.xlarge | \u{1F534} **STOPPED** |',
        '',
        '- **System reachability:** Passed \u2705',
        '- **Instance reachability:** **Failed** \u{1F534}',
        '',
        '> Note: `chatflow-nonprod-mission-control-service` is no longer present.',
    ].join('\n');

    async function run() {
        const docApi = makeDocApi();
        vi.doMock('jspdf', () => ({ jsPDF: vi.fn().mockImplementation(function () { return docApi; }) }));
        const { exportRunToPdf } = await import('./export-pdf');
        await exportRunToPdf({ ...BASE_RUN, result: { summary: SUMMARY } as any }, []);
        vi.doUnmock('jspdf');
        return docApi;
    }

    it('strips inline emphasis and heading markers', async () => {
        const out = drawn(await run());

        // stripInlineMarkdown removes the syntax; the heading text survives
        // sized rather than printed with its hashes.
        expect(out).not.toContain('##');
        expect(out).not.toContain('**');
        expect(out).toContain('Issues Found');
        expect(out).toContain('STX-CLOUD-PLATFORM');
    });

    it('sets table rows in monospace and drops the separator row', async () => {
        // The AI Ops classifier has no table block kind: a row is emitted as
        // `mono` so the pipes at least line up in courier, and the |---|---|
        // separator is dropped rather than printed as dashes.
        const out = drawn(await run());

        expect(out).toMatch(/^\s*\|.*\|\s*$/m);          // rows are kept, pipes and all
        expect(out).not.toMatch(/\|-{3}\|/);             // separator row is not
        expect(out).toContain('i-01f7c1204bc06cd79');
        expect(out).toContain('llm-inference-g6e');
    });

    it('substitutes emoji with the AI Ops markers instead of emitting mojibake', async () => {
        const out = drawn(await run());

        // "Ø=Ý4" was U+1F534's surrogate pair read as Latin-1 by jsPDF's
        // WinAnsi-encoded Helvetica.
        expect(out).not.toContain('Ø');
        expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
        expect(out).toContain('[CRITICAL]');             // AI Ops vocabulary
        expect(out).toContain('[OK]');
    });

    it('normalises list markers to a bullet glyph', async () => {
        const out = drawn(await run());
        expect(out).toContain('•');
        expect(out).toContain('System reachability:');
    });

    it('keeps a blockquote as plain text and drops the horizontal rule', async () => {
        // Neither has a block kind in the AI Ops model: `>` stays in the text
        // and `---` collapses to vertical space, so no rule is ever stroked.
        const docApi = await run();
        const out = drawn(docApi);

        expect(out).toContain('Note:');
        expect(out).not.toMatch(/^---$/m);
        expect(docApi.line).not.toHaveBeenCalled();
    });

    it('renders a markdown task description the same way', async () => {
        const docApi = makeDocApi();
        vi.doMock('jspdf', () => ({ jsPDF: vi.fn().mockImplementation(function () { return docApi; }) }));
        const { exportRunToPdf } = await import('./export-pdf');
        await exportRunToPdf({ ...BASE_RUN, taskDescription: '# Task\n\nCheck **all** EC2 \u{1F680}' }, []);
        vi.doUnmock('jspdf');

        const out = drawn(docApi);
        expect(out).toContain('Task');
        expect(out).toContain('Check');
        expect(out).not.toContain('**');
        expect(out).not.toContain('# Task');
    });
});

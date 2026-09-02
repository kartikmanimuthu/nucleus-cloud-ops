/**
 * Layout regression tests that run against the REAL jsPDF, not a mock.
 *
 * Agent Ops renders through the shared AI Ops engine (@/lib/pdf/pdf-blocks), so
 * what these assert is that engine's output for agent-shaped input: no table
 * layout and no styled runs — but nothing may escape the page box, and nothing
 * may reach jsPDF as a character its WinAnsi fonts cannot draw.
 *
 * export-pdf.test.ts stubs the document with `getTextWidth: () => 10`, which is
 * right for asserting *what* gets drawn but useless for asserting *where*: every
 * string measures the same, so no wrap or column width is exercised honestly.
 * These tests instantiate the genuine jsPDF and wrap `text()` to record the
 * right edge of everything drawn, which is the only way to catch the original
 * defect — content running off the right side of the page.
 *
 * Set PDF_LAYOUT_OUT to a file path to also keep the rendered PDF for eyeballing.
 */

import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'fs';

import type { AgentOpsRun, AgentOpsEvent } from './types';

const M = 15;            // shared writer's page margin (mm)
const PAGE_W = 210;      // A4 portrait (mm)
const RIGHT_EDGE = PAGE_W - M;

const BASE_RUN = {
    PK: 'TENANT#t1', SK: 'RUN#r1', GSI1PK: 'SOURCE#api', GSI1SK: 'x',
    runId: 'run-layout-0001', tenantId: 't1', source: 'api', status: 'completed',
    taskDescription: 'Check all EC2 instances and ECS services across my selected accounts and report anything down or unhealthy',
    mode: 'deep', threadId: 'th1', trigger: {} as never,
    createdAt: '2026-08-27T07:19:59Z', updatedAt: '2026-08-27T07:20:35Z', ttl: 0,
} as unknown as AgentOpsRun;

/** A summary shaped like what the deep agent actually emits. */
const SUMMARY = [
    'Here is the full health report for **STX-CLOUD-PLATFORM (970547372609)** — us-east-1:',
    '', '---', '',
    '## \u{1F534} Issues Found', '',
    '### EC2 — 2 Stopped Instances', '',
    '| Instance ID | Name | Type | State | Last Launch |',
    '|---|---|---|---|---|',
    '| `i-01f7c1204bc06cd79` | **llm-inference-g6e** | g6.xlarge | \u{1F534} **STOPPED** | 2026-08-26T09:14:00Z |',
    '| `i-034e3f4b41aec03ff` | **llm-inference-coding** | g6e.xlarge | \u{1F534} **STOPPED** | 2026-04-02T11:00:00Z |',
    '',
    'Both are GPU inference instances. `llm-inference-g6e` was launched yesterday and stopped the same day, which may indicate a deliberate shutdown after a job completed.',
    '', '---', '',
    '## ✅ ECS Services — All Healthy', '',
    '| Cluster | Service | Desired | Running | Status |',
    '|---|---|---|---|---|',
    '| chatbot-ecs-cluster | chatbot-workers-service | 1 | 1 | ✅ Steady |',
    '| chatflow-nonprod-ecs-cluster | chatflow-nonprod-web-ui-service | 2 | 2 | ✅ Steady (recently redeployed) |',
    '| stox-whatsapp-mcp-ecs-cluster | stox-whatsapp-mcp-uat-service | 0 | 0 | \u{1F7E1} Scaled to zero |',
    '',
    '> Note: `chatflow-nonprod-mission-control-service` previously listed in memory is **no longer present**.',
    '', '---', '',
    '## Summary of Actions Required', '',
    '| Priority | Resource | Issue | Recommended Action |',
    '|---|---|---|---|',
    '| \u{1F534} High | `chatflow-nonprod-bastion-1` (`i-07d777e6318d4a642`) | OS-level reachability check failing for ~2 days | stop/start instance; SSM in to investigate OS logs |',
    '| \u{1F7E1} Low | `llm-inference-coding` (`i-034e3f4b41aec03ff`) | Stopped since April | Evaluate terminating to save costs |',
    '',
    '- **System reachability:** Passed ✅ (AWS hardware/network OK)',
    '- **Instance reachability:** **Failed** \u{1F534} (OS-level health check failing)',
].join('\n');

interface Drawn { text: string; x: number; right: number }
interface Rule { x1: number; y1: number; x2: number; y2: number; page: number }

/**
 * Render through the real jsPDF, recording every drawn string and its right
 * edge. `save()` is redirected so no download is attempted in node.
 */
async function render(run: AgentOpsRun, events: AgentOpsEvent[] = []) {
    const { jsPDF: RealJsPDF } = await import('jspdf');
    const drawn: Drawn[] = [];
    const rules: Rule[] = [];
    let bytes: ArrayBuffer | null = null;

    vi.doMock('jspdf', () => ({
        jsPDF: function (opts: unknown) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const doc: any = new (RealJsPDF as any)(opts);
            const realLine = doc.line.bind(doc);
            doc.line = (x1: number, y1: number, x2: number, y2: number, ...rest: unknown[]) => {
                rules.push({ x1, y1, x2, y2, page: doc.internal.getCurrentPageInfo().pageNumber });
                return realLine(x1, y1, x2, y2, ...rest);
            };
            const realText = doc.text.bind(doc);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            doc.text = (t: any, x: number, y: number, ...rest: any[]) => {
                const str = String(t);
                drawn.push({ text: str, x, right: x + doc.getTextWidth(str) });
                return realText(t, x, y, ...rest);
            };
            doc.save = () => { bytes = doc.output('arraybuffer'); };
            return doc;
        },
    }));

    const { exportRunToPdf } = await import('./export-pdf');
    await exportRunToPdf(run, events);
    vi.doUnmock('jspdf');

    if (bytes && process.env.PDF_LAYOUT_OUT) {
        writeFileSync(process.env.PDF_LAYOUT_OUT, Buffer.from(bytes));
    }
    return { drawn, rules, bytes };
}

describe('exportRunToPdf layout (real jsPDF metrics)', () => {
    it('keeps every drawn string inside the right margin', async () => {
        const { drawn, bytes } = await render({ ...BASE_RUN, result: { summary: SUMMARY } as never });

        expect(bytes).not.toBeNull();
        expect(drawn.length).toBeGreaterThan(20);

        // The original defect: wide table rows and emoji-bearing lines were
        // measured wrongly and ran off the page, so the text was simply cut off.
        // A 0.5mm tolerance absorbs float noise in the width metrics.
        const overflowing = drawn.filter((d) => d.right > RIGHT_EDGE + 0.5);
        expect(overflowing.map((d) => `${d.text.slice(0, 30)} -> ${d.right.toFixed(1)}mm`)).toEqual([]);
    });

    it('starts every drawn string at or after the left margin', async () => {
        const { drawn } = await render({ ...BASE_RUN, result: { summary: SUMMARY } as never });
        expect(drawn.filter((d) => d.x < M - 0.01)).toEqual([]);
    });

    it('breaks a token longer than the page rather than letting it overflow', async () => {
        // A single unbreakable string wider than the content box — an ARN, a
        // long log line — has to be split by character or it overflows.
        const long = 'arn:aws:ecs:us-east-1:970547372609:task-definition/chatflow-nonprod-web-ui-service-with-a-deliberately-absurd-suffix-that-cannot-fit';
        const { drawn } = await render({
            ...BASE_RUN,
            result: { summary: `| Resource |\n|---|\n| \`${long}\` |\n\nAnd inline: \`${long}\`` } as never,
        });

        expect(drawn.filter((d) => d.right > RIGHT_EDGE + 0.5)).toEqual([]);
        // Split, not truncated: the pieces must reassemble to the original.
        expect(drawn.map((d) => d.text).join('')).toContain(long.slice(0, 40));
    });

    it('emits no WinAnsi-unmappable character to the page', async () => {
        const { drawn } = await render({ ...BASE_RUN, result: { summary: SUMMARY } as never });
        const all = drawn.map((d) => d.text).join('');

        for (const ch of all) {
            const cp = ch.codePointAt(0)!;
            // > U+00FF is only legal for the handful of code points WinAnsi maps;
            // anything else is what produced "Ø=Ý4" in the exported PDF.
            if (cp > 0xff) {
                expect([0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac, 0x2122])
                    .toContain(cp);
            }
        }
    });
});
